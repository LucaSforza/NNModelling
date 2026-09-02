/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 * Commercial licenses are available — contact Luca Sforza.
 * See the LICENSE file for details.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 */

import { type Connection, type Edge, type InternalNode, type Node } from "@xyflow/svelte";
import type { Diagram } from "./Diagram.svelte";
import { checkValidConnection as coreCheckValidConnection } from "./core/validation";
import { validateReparenting } from "./core/containment";
import type { ModelBundleResources } from "./type-system/editor-runtime";
import { parseModelManifest, type ModelManifest } from "./core/types";

export type NewProjectFormValues = {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
};

/** Build new-project metadata through the canonical model manifest validator. */
export function manifestFromProjectForm(values: NewProjectFormValues): ModelManifest {
  const candidate = {
    schemaVersion: 2 as const,
    id: values.id.trim(),
    version: values.version.trim(),
    name: values.name.trim(),
    ...(values.description?.trim() ? { description: values.description.trim() } : {}),
    customPackages: [],
    customDatasets: [],
  };
  return parseModelManifest(candidate);
}

export function createEmptyProjectJson(manifest: ModelManifest): string {
  return JSON.stringify({ nodes: [], edges: [], layoutDirection: "vertical", manifest: parseModelManifest(manifest) }, null, 2);
}

// Tipo esatto per il payload dell'evento di trascinamento
export type NodeDragPayload = {
  event: MouseEvent | TouchEvent; // L'evento originale del browser
  targetNode: Node | null;        // Il nodo che stai trascinando
  nodes: Node[];                  // L'array completo di tutti i nodi
};

export interface DockHandleRect {
  nodeId: string;
  handleId: string;
  type: "source" | "target";
  rect: { x: number; y: number; width: number; height: number };
}

const DOCK_DISTANCE_PX = 8;

function handleCenter(handle: DockHandleRect): { x: number; y: number } {
  return {
    x: handle.rect.x + handle.rect.width / 2,
    y: handle.rect.y + handle.rect.height / 2,
  };
}

/**
 * Find the closest source/target handle pair for a node-drop docking gesture.
 * Screen-space geometry is intentional: it matches what the user sees at any
 * canvas zoom without changing the logical graph representation.
 */
export function findDockedConnection(
  targetNodeId: string,
  handles: readonly DockHandleRect[],
): Connection | undefined {
  const targetHandles = handles.filter(
    (handle) => handle.nodeId === targetNodeId && handle.type === "target",
  );
  const sourceHandles = handles.filter(
    (handle) => handle.nodeId !== targetNodeId && handle.type === "source",
  );

  let closest: { distance: number; source: DockHandleRect; target: DockHandleRect } | undefined;
  for (const target of targetHandles) {
    const targetCenter = handleCenter(target);
    for (const source of sourceHandles) {
      const sourceCenter = handleCenter(source);
      const distance = Math.hypot(
        targetCenter.x - sourceCenter.x,
        targetCenter.y - sourceCenter.y,
      );
      if (distance > DOCK_DISTANCE_PX || (closest && distance >= closest.distance)) continue;
      closest = { distance, source, target };
    }
  }

  if (!closest) return undefined;
  return {
    source: closest.source.nodeId,
    sourceHandle: closest.source.handleId,
    target: closest.target.nodeId,
    targetHandle: closest.target.handleId,
  };
}

// HELPER: Riordina i nodi e previene cicli infiniti
function sortNodesByParent(nodesArray: Node[]): Node[] {
  const sorted: Node[] = [];
  const visited = new Set(); // Nodi già sistemati definitivamente
  const visiting = new Set(); // Nodi che stiamo analizzando in questo momento (per beccare i loop)

  function addNode(nodeId: String) {
    // Se lo abbiamo già sistemato, saltiamolo
    if (visited.has(nodeId)) return;

    // Se lo stiamo già visitando e ci torniamo... abbiamo trovato un loop circolare!
    if (visiting.has(nodeId)) {
      console.warn(
        `Rilevato ciclo infinito sul nodo: ${nodeId}. Interrompo la catena.`,
      );
      return;
    }

    // Segniamo il nodo come "in fase di analisi"
    visiting.add(nodeId);

    const n = nodesArray.find((x) => x.id === nodeId);
    if (!n) {
      visiting.delete(nodeId);
      return;
    }

    // Se ha un genitore, assicuriamoci di aggiungere prima il genitore
    if (n.parentId) {
      addNode(n.parentId);
    }

    // Analisi finita: lo togliamo da visiting, lo mettiamo in visited e lo salviamo
    visiting.delete(nodeId);
    visited.add(nodeId);
    sorted.push(n);
  }

  nodesArray.forEach((n) => addNode(n.id));
  return sorted;
}
// HELPER 1: Trova il subflow più piccolo (più profondo) sotto il mouse
function getTargetSubflow(
  draggedNode: Node,
  getIntersectingNodes: (a: Node) => Node[],
): Node | undefined {
  // Calcoliamo l'area del nodo che stiamo trascinando
  const draggedIsSubflow = draggedNode.type === "subflow";
  const draggedArea =
    (draggedNode.measured?.width ?? draggedNode.width ?? 0) *
    (draggedNode.measured?.height ?? draggedNode.height ?? 0);

  const intersections = getIntersectingNodes(draggedNode).filter(
    (n) => {
      // Deve essere un subflow e non deve essere se stesso
      if (n.type !== "subflow" || n.id === draggedNode.id) return false;

      // LA TUA NUOVA REGOLA: Se sto trascinando un subflow, 
      // ignoro i subflow bersaglio che hanno un'area minore della mia.
      if (draggedIsSubflow) {
        const targetArea =
          (n.measured?.width ?? n.width ?? 0) *
          (n.measured?.height ?? n.height ?? 0);

        if (targetArea < draggedArea) return false;
      }

      return true;
    }
  );

  if (intersections.length === 0) return undefined;

  // Trova quello con l'area minore tra i superstiti idonei
  return intersections.reduce((smallest, current) => {
    const sArea =
      (smallest.measured?.width ?? smallest.width ?? 0) *
      (smallest.measured?.height ?? smallest.height ?? 0);
    const cArea =
      (current.measured?.width ?? current.width ?? 0) *
      (current.measured?.height ?? current.height ?? 0);
    return cArea < sArea ? current : smallest;
  });
}
// LOGICA REPARENTING
export function onNodeDragStop(
  payload: NodeDragPayload,
  nodes: Node[],
  getIntersectingNodes: (node: Node) => Node[],
  getInternalNode: (id: string) => InternalNode | undefined,
  edges: Edge[] = [],
): Node[] | undefined {
  const node: Node | null = payload?.targetNode;
  if (!node) return;

  const currentParentId = node.parentId;
  const newParent = getTargetSubflow(node, getIntersectingNodes);
  const newParentId = newParent?.id;

  // --- EARLY EXIT: Se il padre non è cambiato, non facciamo nulla ---
  if (currentParentId === newParentId) return;

  // Keep containment ancestry valid and reject a move that would strand an
  // existing incident edge across scopes. This is entirely pre-mutation:
  // FlowCanvas receives undefined and leaves nodes and edges untouched.
  const containment = validateReparenting(nodes, edges, node.id, newParentId);
  if (!containment.valid) {
    console.warn(`Spostamento bloccato: ${containment.reason}`);
    return undefined;
  }

  // --- PREPARAZIONE DELLE COORDINATE ---
  const internalNode: InternalNode | undefined = getInternalNode(node.id);
  const nodeAbs = internalNode?.internals?.positionAbsolute ?? node.position;

  // --- AGGIORNAMENTO STATO ---
  const updatedNodes = nodes.map((n) => {
    if (n.id !== node.id) return n;

    let finalPosition = { ...nodeAbs };
    let expandParent = false;

    if (newParent) {
      const internalParent = getInternalNode(newParent.id);
      const parentAbs =
        internalParent?.internals?.positionAbsolute ?? newParent.position;

      finalPosition = {
        x: nodeAbs.x - parentAbs.x,
        y: nodeAbs.y - parentAbs.y,
      };
      expandParent = true;
    }

    return {
      ...n,
      parentId: newParentId,
      position: finalPosition,
      expandParent: expandParent,
    };
  });

  return sortNodesByParent(updatedNodes);
}

// --- VALIDAZIONE CONNESSIONI ---
export function checkValidConnection(diagram: Diagram, connection: Connection | Edge): boolean {
  // Svelte Flow only asks about live nodes. Retaining the legacy fallback for
  // synthetic test connections avoids treating a non-existent endpoint as a
  // UI containment scope; DiagramCore mutations always pass all nodes and are
  // strict about unknown endpoints.
  const hasSource = diagram.nodes.some((node) => node.id === connection.source);
  const hasTarget = diagram.nodes.some((node) => node.id === connection.target);
  const result = coreCheckValidConnection(
    diagram.edges,
    connection.source,
    connection.target,
    connection.sourceHandle ?? undefined,
    connection.targetHandle ?? undefined,
    hasSource && hasTarget ? diagram.nodes : undefined,
  );
  return result.valid;
}

// --- LOGICA DI SALVATAGGIO (Download File) ---
export function handleSaveModel(diagram: Diagram) {
  const jsonStr = diagram.exportToJson();

  // Creiamo un Blob di testo (un file virtuale in memoria)
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  // Trucco HTML: creiamo un tag <a> invisibile, lo clicchiamo e lo distruggiamo
  const a = document.createElement("a");
  a.href = url;
  a.download = "modello_ai.json"; // Nome del file di default
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url); // Pulizia della memoria
}

// --- LOGICA DI CARICAMENTO (Upload File) ---
export function handleLoadModel(
  diagram: Diagram,
  onLoad?: () => void,
  onError?: (message: string) => void,
) {
  // L'input deve essere nel document mentre la finestra nativa è aperta.
  // Questo è necessario in Chrome/Linux e rende inoltre possibile usare
  // DOM.setFileInputFiles durante i test end-to-end via CDP.
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.style.display = "none";
  document.body.appendChild(input);

  const cleanup = () => input.remove();

  input.onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) {
      cleanup();
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      const fileContent = event.target?.result as string;
      if (!fileContent) {
        onError?.(`Il file "${file.name}" è vuoto.`);
        cleanup();
        return;
      }

      const imported = await diagram.importProjectJson(fileContent);
      if (imported) {
        onLoad?.();
      } else {
        onError?.(
          `Impossibile caricare "${file.name}": il file deve essere un diagramma JSON con gli array "nodes" e "edges".`,
        );
      }
      cleanup();
    };
    reader.onerror = () => {
      onError?.(`Impossibile leggere il file "${file.name}".`);
      cleanup();
    };
    // Leggiamo il file come testo semplice
    reader.readAsText(file);
  };

  // Se l'utente chiude la finestra senza scegliere un file, puliamo l'input.
  input.addEventListener("cancel", cleanup, { once: true });

  // Simuliamo il click per aprire la finestra di dialogo del SO
  input.click();
}

export type ModelBundleUploadFile = {
  readonly name: string;
  readonly webkitRelativePath?: string;
  text(): Promise<string>;
};

export type LoadedModelBundle = {
  readonly modelJson: string;
  readonly resources: ModelBundleResources;
};

/** Read a model directory selected through a directory file input. */
export async function readModelBundleFiles(
  files: readonly ModelBundleUploadFile[],
): Promise<LoadedModelBundle> {
  const entries = files.map((file) => ({
    file,
    path: (file.webkitRelativePath || file.name).replaceAll("\\", "/"),
  }));
  const modelEntries = entries.filter(({ path }) => path === "model.json" || path.endsWith("/model.json"));
  if (modelEntries.length !== 1) {
    throw new Error("Seleziona una directory bundle contenente un solo model.json.");
  }

  const modelPath = modelEntries[0]!.path;
  const root = modelPath.slice(0, -"model.json".length);
  const resources: Record<string, string> = {};
  for (const { file, path } of entries) {
    if (!path.startsWith(root)) continue;
    const relativePath = path.slice(root.length);
    if (!relativePath || relativePath.includes("..") || relativePath.startsWith("/")) continue;
    resources[relativePath] = await file.text();
  }

  const modelJson = resources["model.json"];
  if (modelJson === undefined) {
    throw new Error("Il bundle selezionato non contiene model.json nella sua radice.");
  }
  return { modelJson, resources };
}

/** Load a model bundle directory, including model-owned package resources. */
export function handleLoadModelBundle(
  diagram: Diagram,
  onLoad?: () => void,
  onError?: (message: string) => void,
) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".json,application/json";
  input.setAttribute("webkitdirectory", "");
  input.setAttribute("directory", "");
  input.style.display = "none";
  document.body.appendChild(input);

  const cleanup = () => input.remove();
  input.onchange = async () => {
    try {
      const files = [...(input.files ?? [])];
      const bundle = await readModelBundleFiles(files);
      const imported = await diagram.importProjectJson(bundle.modelJson, bundle.resources);
      if (!imported) throw new Error("Il bundle non contiene un diagramma JSON valido.");
      onLoad?.();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      cleanup();
    }
  };
  input.addEventListener("cancel", cleanup, { once: true });
  input.click();
}

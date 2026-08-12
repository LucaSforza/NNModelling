# Task report-update — Aggiornare ase_report.tex con Phases 2-5

**Delegate to**: `@frontend`
**Depends on**: Phase 1-5 implementation complete
**Note**: The implementing agent MUST read this entire design doc AND `analysis/report/ase_report.tex` before starting.

---

## Objective

La Sezione 4 ("Static Tensor Type System") di `analysis/report/ase_report.tex` descrive solo Phase 1 (Input, Linear, ReLU). Mancano completamente:
- Phase 2: computed dimensions (Conv2d, MaxPool2d, Flatten) + 10 shape-preserving modules
- Phase 3: join type checking (Addition, Concat, MatMul, ScaledDotProduct, MaskedScaledDotProduct)
- Phase 4: subflow type inference (Repeat, HorizontalRepeat, generic subflows)
- Phase 5: editor integration (error panel, node indicators, shape tooltips)

---

## Part A — Nuove sottosezioni da aggiungere dopo §4.5 (Constraint-Based Inference Algorithm)

### A1. Computed Dimensions (§4.6)

Aggiungere una sottosezione che descriva come alcuni moduli producono dimensioni calcolate da formule:

**Conv2d output**: \( H_{\text{out}} = \lfloor (H + 2p - d(k-1) - 1) / s + 1 \rfloor \)

**MaxPool2d/AvgPool2d**: \( H_{\text{out}} = \lfloor (H + 2p - k) / s + 1 \rfloor \)

**Flatten**: \( d_{\text{flat}} = \prod_i d_i \) (prodotto delle dimensioni catturate dal wildcard)

Menzionare che la formula è dichiarata nel `type_signature` JSON con `{ "kind": "computed", "formula": "conv2d_hw", "args": [...] }`.

### A2. Join Type Checking (§4.7)

Descrivere il type checking multi-input per i join:

**Addition**: Tutti gli input devono avere shape identiche. Il pattern usa wildcard catturati e confrontati.

**Concat**: Concatenazione lungo un asse. Tutte le altre dimensioni devono matchare. L'output sull'asse di concat è la somma delle dimensioni degli input.

**MatMul**: \( (M, K) \times (K, N) \rightarrow (M, N) \). Unificazione simbolica: `$K` appare in entrambi i pattern e viene unificato.

**ScaledDotProduct**: \( Q(B,H,L,D) \times K(B,H,S,D) \times V(B,H,S,D_{\text{out}}) \rightarrow (B,H,L,D_{\text{out}}) \). 4 dimensioni simboliche unificate tra i 3 input.

Includere un esempio di errore (Addition mismatch, MatMul K conflict).

### A3. Subflow Type Inference (§4.8) — solo se Phase 4 è già implementata

Descrivere l'inferenza ricorsiva:

**Generic subflow**: Type inference ricorsiva sul grafo interno. L'input type esterno viene iniettato come output type dell'Input node interno. Il tipo di uscita del subflow è il tipo dell'exit node interno.

**Repeat**: Esegue N copie in sequenza. Shape-preserving: output shape = input shape.

**HorizontalRepeat**: N copie parallele concatenate sull'ultima dimensione. Output shape = input shape con ultima dim moltiplicata per N.

### A4. Editor Integration (§4.9)

Descrivere brevemente come il type system è integrato nell'editor:

- **Trigger**: TypeEngine.infer() chiamato a ogni modifica del grafo (edge connect/disconnect, parametri modificati con debounce 300ms)
- **Error panel**: Sezione collassabile nella sidebar elenca errori e warning
- **Node indicators**: Bordi rossi per errori, ambra per warning
- **Shape tooltips**: Hover sull'output handle mostra la forma inferita

---

## Part B — Aggiornare il conteggio moduli nella Section 5 (Implementation)

La Section 5 (Implementation) dice che il type system copre "Input, Linear, ReLU". Aggiornare per riflettere che copre:
- 15 module type signatures
- 5 join type signatures
- Subflow type inference (Repeat, HorizontalRepeat, generic)
- Computed dimensions per Conv2d, MaxPool2d, AvgPool2d, Flatten, Unsample

---

## Part C — Aggiungere riferimenti al type_system.rst

Alla fine della Section 4, aggiungere un riferimento alla documentazione utente:

```
The type system is fully documented in the project's user guide at
\texttt{docs2/source/type\_system.rst}, which includes an
educational walkthrough, formal definitions, and detailed examples
for every module.
```

---

## Files to Modify

| File | Change |
|------|--------|
| `analysis/report/ase_report.tex` | Aggiungere §§4.6-4.9 + aggiornare conteggi in §5 |

---

## Test Plan

- Compilare il LaTeX: `cd analysis/report && pdflatex ase_report.tex` (o `latexmk`)
- Verificare nessun errore di compilazione
- Verificare che tutte le formule matematiche siano renderizzate correttamente
- Verificare che la Table of Contents rifletta le nuove sottosezioni

---

## Execution Order

1. **LEGGERE** `analysis/report/ase_report.tex` completo (l'agente DEVE farlo)
2. **LEGGERE** `docs2/source/type_system.rst` per allineare i contenuti
3. Aggiungere le sottosezioni mancanti dopo §4.5
4. Aggiornare i conteggi in §5
5. Aggiungere il riferimento incrociato a `type_system.rst`
6. Compilare e verificare
7. Commit: "docs: update ase_report.tex with type system Phases 2-5"

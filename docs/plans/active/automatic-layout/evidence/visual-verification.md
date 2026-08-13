# Visual verification

Verified on 2026-08-13 in the Codex in-app browser against the live frontend at
`http://127.0.0.1:5174/`.

## Acceptance matrix

| Example | Check | Observed result |
| --- | --- | --- |
| `skip_connections_with_repetition` | Vertical layout | Flow is top-to-bottom; skip branches and both Repeat subflows remain connected and contained. |
| `skip_connections_with_repetition` | Horizontal layout | Flow is left-to-right; custom and subflow handles move to left/right, while join inputs keep their `in-N` identities on a vertical input axis. |
| `skip_connections_with_repetition` | Collapse, layout, expand | The collapsed subflow remains compact; expanding restores calculated bounds and arranged hidden children. |
| `skip_connections_with_repetition` | Undo and redo | Undo restores vertical geometry and top/bottom handles; redo restores horizontal geometry and left/right handles. |
| `skip_connections_with_repetition` | Persistence compatibility | Loading horizontal presentation metadata restores side handles; loading the unchanged legacy file defaults to vertical. |
| `auto_encoder_submodels_with_submodels` | Vertical and horizontal nested layout | Outer and inner subflows remain recursively contained in both directions, including collapsed internal subflows. |

The toolbar remained usable at the tested viewport, `fitView` ran after handle
orientation changed, and the browser console reported no layout-related errors.

The nested autoencoder fixture shows three pre-existing tensor diagnostics even
before layout (`in_channels=1, got 784` and two missing shape dimensions). The
valid skip/repeat fixture has no hard type diagnostics before or after layout.

## Automated verification

- Frontend type/Svelte check, unit tests, production build and both targeted
  smoke commands pass.
- The smoke harness now avoids creating an empty type-invariant suite when a
  single selected fixture does not declare `refreshTypesClean`.
- The aggregate documentation command cannot start TypeDoc because `typedoc`
  is not installed in the workspace. The Sphinx sources were parsed separately;
  remote intersphinx inventories remain unavailable in the restricted network.

**Design QA Evidence**

- Source visual truth: `/var/folders/hq/86kg2knx1ssgjjb60bhgd4tr0000gn/T/codex-clipboard-de23af33-0028-484b-b621-de3140cf8da2.png`
- Browser-rendered implementation: `/tmp/tooling-blocks-desktop.png`
- Source pixels: `1204 x 1244`
- Implementation pixels: `1151 x 1203`
- Implementation CSS viewport: `1151 x 1203`; screenshot normalized to CSS pixels by the in-app browser
- State: authenticated local sandbox, Tooling Hub > Blocks > Requirements > Pending, with one Job Card-generated requirement

**Findings**

- No actionable P0, P1, or P2 differences were found.
- The implementation preserves the source Procurement hierarchy, typography, translucent surfaces, chip treatment, search/export toolbar, table density, status badge treatment, and approval action.
- The KPI strip and Warehouse chip are intentional additions from the Tooling Hub requirements, not visual drift.
- Plate, Die, and Block naming replaces the source board/requisition language as required.

**Required Fidelity Surfaces**

- Fonts and typography: existing ERP font stack, weights, line height, zero letter spacing, hierarchy, wrapping, and compact table labels are consistent with the source.
- Spacing and layout rhythm: page header, actions, KPI strip, chips, toolbar, and table use the existing ERP spacing and elevation tokens. The narrower content area is caused by the persistent application sidebar visible in the implementation capture.
- Colors and visual tokens: the pale blue workspace, white translucent panels, blue information states, green ready/approval states, and amber pending states match the source system.
- Image quality and asset fidelity: neither view requires product imagery. Existing Lucide icons are sharp and consistent; no placeholder or improvised visual assets were introduced.
- Copy and content: workflow labels and inventory terminology are specific to the selected tooling family while retaining Procurement conventions.

**Full-View Comparison Evidence**

- The source and implementation were emitted together in one comparison pass. Both show the same top-right utility area, left-aligned operational title, right-aligned procurement actions, chip-based workflow navigation, search/export toolbar, and dense operational table.
- The implementation adds the requested KPI cards above the workflow chips and keeps the Job Card requirement visible above the fold.

**Focused Region Comparison Evidence**

- The requirement row was checked at readable scale: requirement number, linked Job Card, product identity, tooling master, warehouse availability, quantity, needed-by date, approval status, and action remain legible and aligned.
- The action area matches the source pattern with a green Approve button and adjacent overflow menu.

**Responsive And Interaction Checks**

- Phone-width check: effective CSS viewport `388 x 840`; no document-level horizontal overflow. KPI cards collapse to two columns, table rows become compact cards, and workflow chips remain horizontally scrollable.
- Primary interactions tested: family navigation, requirement approval state, PO list, printable PO, GRN/QC receipt, Warehouse stock, and Plates/Dies/Blocks queue rendering.
- Browser console: no new errors after authenticated reload. Earlier session-expired entries were caused by the intentional local backend restart during verification.

**Comparison History**

- Pass 1: no P0/P1/P2 visual issues. One non-visual printable-PO totals defect was found during interaction testing and fixed; the refreshed PO shows taxable `₹500`, CGST `₹45`, SGST `₹45`, and grand total `₹590`.

**Implementation Checklist**

- [x] Match Procurement workflow structure and controls.
- [x] Add requested tooling KPI and dedicated Warehouse surfaces.
- [x] Verify dense table and phone-width card layout.
- [x] Verify key procurement and inventory interactions.
- [x] Recheck the browser console after the final reload.

final result: passed

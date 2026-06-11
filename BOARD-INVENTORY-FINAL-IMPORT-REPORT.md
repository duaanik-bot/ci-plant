# Board Inventory Final Import Report

Imported at: 2026-06-11T05:43:43.022Z
Source workbook: /Users/anikdua/Documents/Projects/Board Inventory  Final ci production .xlsx

## Import Summary

- Excel rows processed: 260
- Excel material codes missing in DB: 0
- Nonzero stock rows imported: 64
- Total available packets: 3054
- Total available sheets: 320932
- Estimated total stock weight kg: 48313.972
- Active inventory rows after import: 260
- Inventory rows with available stock after import: 64
- Paper ledger rows after import: 64
- Opening stock movement rows after import: 64

## Mapping Rules

- `Material` mapped to `inventory.materialCode`.
- `Board / GSM` parsed into `boardType`, `boardClassification`, and `gsm`.
- `Size` parsed as inch length and width.
- `Sheets` mapped to `qtyAvailable` and `physicalStockSheets`.
- `Available(Packets)` retained through calculated packet size validation.
- `Packet size` mapped to `sheetsPerPacket`.
- Existing current stock balances were zeroed before importing Excel stock.
- Old `paper_warehouse` rows were cleared and recreated only for nonzero Excel rows.
- Extra inventory codes not present in Excel were zeroed and deactivated, not deleted.

## Extra Codes Deactivated

- LEFTFLOW02180059
- LEFTFLOW02180145
- LO-LEFTFLOW-12x23-309450
- PAPERFLOW02171048
- PAPERFLOW02171158
- PLANFLOW02174129
- PLANFLOW02174155
- PLANFLOW02174219
- PLANFLOW02174317
- PLANFLOW02174404
- TRIAL-SBS-300-760X1020

## Largest Imported Stock Rows

- 2228SAFF340: 34300 sheets (343 packets)
- 2530SAFF320: 32800 sheets (328 packets)
- 2530SAFF290: 32600 sheets (326 packets)
- 2228FBB290: 20000 sheets (200 packets)
- 2530FBB290: 19200 sheets (192 packets)
- 2336FBB280: 18000 sheets (180 packets)
- 2038FBB290: 13200 sheets (132 packets)
- 2138FBB340: 11100 sheets (111 packets)
- 2228DPWB350: 9504 sheets (66 packets)
- 2228FBB250: 7000 sheets (70 packets)
- 2038SAFF340: 6600 sheets (66 packets)
- 2530FBB250: 6000 sheets (60 packets)
- 2530FBB320: 6000 sheets (60 packets)
- 2328DPWB320: 5760 sheets (40 packets)
- 2532FBB270: 5600 sheets (56 packets)

## Backup

Backup written before import: /Users/anikdua/Documents/Projects/CI-Production/BOARD-INVENTORY-FINAL-IMPORT-BACKUP-2026-06-11T05-43-43-022Z.json

# Output layout options — design (13 Nov 2026)

## The owner's request

> key line u are making is good but we need proper layout options also for output setting

13 Nov: "Just start" — he skipped the questions. Everything below that is not in his words is **my call**.

## What "output" means here (my call)

The KLD is one carton's die line. The **output** is the print sheet with every up on it: the sheet layout that goes to
the plate and die makers (page two of the KLD PDF). Today CI Plant draws ONE arrangement there, the one the house rules
pick. The owner wants to choose it, and to set the output's own margins.

## What it does

1. **Output settings** on the KLD panel. They default to the house rules (edge to edge, all 0):
   - **Gripper** (mm), taken off one long edge;
   - **Edges** (mm), taken off the other three;
   - **Gap between ups** (mm), added between every two ups, both ways.
2. **Layout options** for the costing's sheet and ups: every way to place exactly that many ups, across every reading
   of the style (side-open / top-open for side pasting; lock bottom), either sheet side, every rows × columns grid.
   Each option shows:
   - its picture, with the gripper band and margins;
   - rows × columns, and which side the cartons' width runs along (so which way the grain must run);
   - the spare mm both ways, or how far it runs past the sheet by the house rules;
   - the most ups the sheet takes by the rules.

   The options that fit come first, the roomiest first. Then come the ones over the rules, least over first. An option
   more than 150 mm over is no layout and is left out **(my call)**. **No hard blocker**: an over-the-rules option can
   still be picked, and the KLD says by how much, as since 12 Nov.
3. **Pick one, then Make KLD / Redraw.** The KLD is drawn on that layout with those settings. Both are kept with the KLD
   (its `layout`), so every costing of that Size Library entry shows the same output. A saved KLD opens with its own
   layout picked.
4. **The KLD PDF's page two becomes the output sheet**:
   - the sheet in inches and mm, the gripper band marked GRIPPER, the edges;
   - every up numbered, at its place with the gaps;
   - rows × columns, the grain the board needs, the settings;
   - the over-the-rules note when there is one.

## Rules

- The house rules stay the defaults, and the settings change nothing until the owner types them.
- The settings are millimetres, from 0 to 50 each **(my call)**; anything else is refused with a reason.
- The same geometry draws the screen picture, the PDF and the fit check (client/src/lib/sizing.js), as before.

## Not in this change

- Mixed layouts (some ups turned 90° on one sheet), and work-and-turn.
- Bleed and colour bars as drawn items: the margins leave room for them, but they are not drawn.

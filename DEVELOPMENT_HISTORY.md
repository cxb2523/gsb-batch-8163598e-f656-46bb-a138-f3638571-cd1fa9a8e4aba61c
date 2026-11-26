# Current interface

The active workflow is **Shape → Artwork → Print**. Choose dimensions, download the labeled template and prompt, generate the artwork externally in ChatGPT Images, then upload one finished image. Upload fits every face and opens Print automatically. Print offers Fit all faces, image replacement and PDF settings. Manual layers, color editing, face dragging, the Brand/Design steps and PDF brand-book ingestion have been removed from the app. Existing saved images and legacy layers are retained for compatibility; legacy step numbers migrate to the three-step workflow.

The remainder below documents earlier construction and implementation history.

# Fold Studio — local working prototype

English four-step packaging editor: Shape → Brand → Design → Print. Manrope, monochrome controls, a light dot grid and fixed `letter-spacing: 0.04em`.

## Run

Requires Node.js 20.19+ or 22.12+.

```powershell
npm.cmd install
npm.cmd run dev
```

Open http://127.0.0.1:4188/. Build with `npm.cmd run build`.
Images, fonts, PDF processing and export run locally. No API key is required.

## Working features

- 18 deduplicated constructions drawn from the two supplied reference boards: lift-off lid, tuck carton, mailer, display tray, book flap, drawer/sleeve, gable handle, carry case, house, hanging carton, hexagon, octagon, pyramid, wedge, envelope pouch, open sleeve, takeout, and open tray. Each has a line illustration of the assembled shape, real panel geometry and a matching unfolded view. Search and family filters are available in the first-step shape collection.
- Upload original logos and artwork, edit per-face layers, or take a blank template to an external image editor. Transparent logos retain their alpha without an automatic white label. Old direction/shuffle cards have been removed from the design step.
- Advanced face editing is opt-in. Character eyes are decoration and never create duplicate entries in the construction catalog. Optional windows and handles are cutouts in both 3D and print.

- Classic lift-off-lid box plus distinct polygonal, roofed, handled, tapered, wrapping, tray and sleeve structures.
- Independent width/depth/height in mm and stock allowance for the lid.
- PNG/JPG/WebP/SVG uploads, dominant-color extraction, initial logo placement and supporting text across faces.
- PDF brand-book import: first four pages, sampled colors, embedded raster images or the first page as artwork. Upload vector-only logos separately as SVG. This is deterministic layout assistance, not AI interpretation of brand rules.
- Per-face backgrounds, text, scale, rotation, layers and patterns. Drag artwork directly on the 3D box. Arrow keys nudge selected artwork; Shift makes larger steps. Drag empty space to orbit; scroll to zoom.
- Fold/unfold animation and matching 2D net.
- Interior paper follows the selected paper/accent palette, with a slightly deeper bottom so it remains visible on the white stage, including an all-white palette. This is a 3D paper-stock/material preview, not an additional inside-print layer in the PDF.
- Interior faces have their own correctly oriented, slightly inset geometry and receive real-time shadows. The key light casts from both sides of each thin paper panel; its shadow camera fits the whole opening path. Lifted lids cast onto the inner bottom, walls and ground. Bias and normals prevent self-shadow striping without disabling interior shadows.
- Left-click the assembled box to open or close it. Fifteen construction-specific mechanisms move actual rigid panels: lift-off lid, sliding drawer, hinged lids, roof/triangle flaps and staged tuck closures. Handled cartons fold the handle tab back before releasing the flap so the parts do not pass through each other. A second click reverses smoothly from the current position. Dragging orbits; right clicks and clicks on empty space do not open the box. Advanced layer dragging keeps its editing behavior.
- The removable lid first lifts completely clear of the rim, moves beside the base, and lowers until its skirt rests on the same tabletop as the box. It keeps its horizontal orientation; closing follows the path in reverse. Extreme width/depth/height combinations are checked for collisions and table contact.
- Overlapping tuck/envelope flaps and lift-off lid skirts have a stock-thickness edge profile and a subtle depth-tested cut-edge line. They follow the actual panel hinges and update with paper color. Fold hinges are excluded from this treatment. These are material details in the 3D preview; artwork and PDF cut/fold geometry are unchanged.
- An explicit Open/Close button and Enter/Space support the same action. System reduced-motion preference snaps to the requested state. Open trays, the display tray and the open sleeve are labeled already open; the three blocked closure studies remain unavailable. The camera reserves space for the opening path. PDF projection remains independent of the open preview.
- A4, A3 and US Letter PDFs at actual scale, vector cut/crease lines, 50 mm rulers, 5 mm overlapping tiles for large pieces and assembly instructions. RGB artwork at approximately 203 dpi. Optional 2 mm solid background extension; not full image bleed or CMYK preflight.
- Save/open JSON projects with embedded images, browser autosave subject to quota, preview PNGs and mobile layout.

## Validation and limits

### Template → external design → editable box

In Brand or Design, open **Get template & prompt**. Print layout also has **Download template**, **Copy prompt** and **Upload your design**.

- Download is one ordinary opaque white PNG, 4096 × 2730, containing blank pieces, solid cuts, dashed folds, cut-out holes and pale unprinted glue tabs. It contains no current artwork. Preview-only constructions remain blocked from template/PDF export.
- Copy the editable English prompt and add personal instructions inside its final square brackets. Attach the template, original logo and reference images in Nano Banana or any image generator/editor. The prompt asks for cohesive packaging, unchanged canvas/piece geometry, safe text placement and removal of template guides from the final image. It does not guarantee that an external model obeys.
- The prompt now includes an editor-generated locked map: each panel's exact pixel polygons, bounds, holes, artwork rotation and unprinted glue regions. It explicitly treats dashed folds as hard compositional boundaries, forbids moving frames/characters into neighboring panels, and requires full edge coverage without white slivers. The map is regenerated for the current geometry even when reusing a customized prompt; user wishes are retained. This strengthens instructions but does not enforce an external model's output.
- Return one PNG/JPG/WebP, without cropping or adding borders. The placement map is saved in IndexedDB before the template download starts; up to 12 shape/size maps are retained in the project, and portable Save project JSON includes them. No ZIP or sidecar JSON is downloaded or required on return. Keep or restore the original box shape/size. If storage is cleared, download that box's template again to reconstruct the map.
- Apply the image to the box and adjust translation, uniform scale and rotation either on the whole template canvas or on a selected face. Per-face adjustments crop to that face's source canvas, so they do not drag neighboring faces into the edited area. Undo adjustment, reset current scope and reset all are available. Changes update the 3D material and printable artwork together while vector cut/fold geometry stays fixed. Adjustments and the source image survive Save/Open and autosave restoration.
- Add original logos and text as separate editable face layers after importing. The image's baked-in text and illustrations are not individual editable objects. Existing separate layers remain on top of the imported artwork when adjusting alignment. Restore previous design undoes the import as a whole.
- Proportion changes, insufficient resolution, absent maps and mismatched selected dimensions are rejected with plain instructions. The editor cannot identify every rearranged panel, cropped image that was subsequently rescaled back, or marks an external generator leaves in its output. Inspect every side and make a physical test print.
- **Remove narrow white edge seams** extends the nearest printed pixels into near-white edge strips up to 2 mm (also limited to 4% of the face). It does not move, crop or scale the main artwork. It applies only to otherwise densely printed faces; broad white borders and mostly white logo designs are left alone. The option is enabled by default and can be turned off for intentional thin white frames. Repair is shared by the 3D material and PDF, with untouched vector geometry and glue tabs. Imported face renders are cached so ordinary layer editing does not repeatedly scan all pixels. This repairs small coverage gaps, not illustrations crossing a fold.

The built-in generation feature, account/key settings, ZIP exchange and old shuffle controls have been removed. All interface text is English. No external AI service is called by this workflow.

Validation: browser checks downloaded and inspected the blank PNG; copied a customized prompt; returned an asymmetric colored fixture using only an image; rejected wrong aspect ratio, changed dimensions and absent maps; verified global transforms, isolated per-face transforms, exact undo/reset, unchanged dielines, persistence, PDF export and mobile overflow. The PDF was reopened at A4 dimensions and rendered for visual inspection. This uses a controlled fixture, not a claim that a live external AI model will keep panel alignment. `node audit-artwork-transform.mjs` checks affine directions, uniform scale, centered rotation and invalid inputs. Existing construction checks still pass, with the three unsupported studies blocked.

Browser checks cover SVG upload, palette/layout, independent resizing, editing, PDF download, large tiled exports, PDF image extraction, project round trip, autosave restoration and mobile overflow. Direct pointer dragging was checked on the 3D lid. Exported PDFs were reopened and rendered; physical dimensions, A4 page size and page counts were checked.

Print a test box at **100% / Actual size** on the intended stock. Geometry follows crease lines with added lid clearance. Real fit depends on paper, scoring and printer settings. Physical assembly has not been tested; this is not a manufacturing-certified cutting die.

The new construction library is a geometry prototype, not a traced or certified commercial dieline catalog. Detailed assembly instructions and physical fit validation remain a separate next stage, as requested. Tuck-end direction, automatic bottoms and tear strips shown in the reference are closure/manufacturing variants of the same rectangular carton, not duplicate shape cards. Tall/short hexagonal cartons, repeated carry boxes and differently printed boxes are likewise consolidated.

The original flat-overlap check was insufficient to establish buildability. The current catalog audit checks 243 configurations: panel planarity, invariant edge lengths, target positions after refolding, flat panel overlap, final assembled intersections, required glue seams, retained tab area and actual trimmed-tab contact with the intended neighboring face. Negative controls inject the original 90-degree-tab bug, distorted panels, missing tabs and colliding petals; all four must be rejected. Run `npm.cmd run audit`; evidence is saved to `output/validation/construction-audit.json`.

All 18 catalog constructions pass these computational checks. Pillow, candy wrap and petal crown have been removed from the catalog because their paper closure geometry was not validated. Legacy projects retain their uploaded images and archive their old construction data, then open at Shape with a supported box; an explicit notice asks the user to choose a new box and template. Passing constructions export explicitly labeled test templates. No construction is marked physically tested. Stock thickness, load-bearing handles, locking/friction closures, adhesive and feasible manual assembly order remain unverified.

Miniatures are rendered from `makeSpec()` and the same folded panel polygons and cutouts used by the editor, using `paper-model.js`; independent hand-drawn icons were removed. Selected thumbnails update with dimensions and windows. Browser verification checked all 18 catalog cards, exported the 18 allowed templates, confirmed the removed shapes are absent, mobile layout, dimension-sensitive thumbnails and agreement between main-renderer vertices and intended assembled positions (maximum GPU-mesh coordinate error below 0.0001 mm). Exported PDFs carry verification metadata with `physicalTested: false`.

Opening motion is a separate state from assembly/unfolding. `npm.cmd run audit:opening` checks 615 sampled poses across 15 mechanisms for panel intersections, rigid edge lengths, fixed hinge positions and exact return to the closed pose, plus damping at 30/60/120 fps and interrupted reversals. Browser checks cover the left-click toggle, camera dragging, right/empty clicks, keyboard controls, reduced motion, mobile layout, fold/unfold coordination and unchanged PDF geometry while the preview is open. This does not certify hinge fatigue, seal strength, load-bearing handles or a physical locking mechanism.

Rendering regression checks cover the internal bottom on all 18 catalog forms, inward-facing normals and material updates for white and colored palettes. A pixel comparison with only the lid's shadow casting disabled verifies a visible change on the projected bottom area, rather than relying solely on shadow flags. Mobile rendering and console errors are also checked.

To make opening physically possible, the corresponding lid/roof/front panel seams are left unglued in the net. Polygon lids, roof flaps, the wedge and the pyramid need a removable seal to hold closed; the on-screen guide and PDF print notes say so. Do not glue these moving panels shut. The drawer now starts fully inserted rather than partly extended.

## Fitting imported artwork

Importing a finished flat image proposes a crop for every printable face. Auto-fit searches nearby panel edges; it is a starting point, not guaranteed segmentation. In Design, choose a side and **Choose this side’s picture** to drag the source rectangle or its corners, rotate it by 90 degrees, then **Stretch to this side**. The selected source rectangle fills that face edge to edge; the original paper polygon still clips the artwork. The original uploaded image is preserved, and each face is sampled directly from it without AI regeneration. Crops are included in undo, project save/autosave, 3D textures and PDF output. Reset alignment removes the corresponding crop.

The demonstration artwork was generated once from the original references. Fitting is a separate rendering operation, not another image-generation pass. It cannot correct malformed text or illustration details inside the source image.

## Source and permission

Based on https://github.com/riavijay/boo-tique. Original HTML is preserved in `upstream/boo-tique.html`. Hinged panels and flat-world print projection adapt the original (the character drawing that was also adapted from it has since been removed); the editor and dimensioned PDF workflow are new.

**Upstream has no explicit license. This is a local prototype; obtain permission before publishing or redistributing the derivative.** No license is asserted over upstream code. Manrope uses the included SIL Open Font License in `public/fonts/OFL.txt`. Package licenses remain with their owners.

Print export supports **Full dieline · one custom-size sheet** at 1:1. A4, A3 and Letter remain tiled at actual size when required; their orientation is chosen to minimize sheet count. A separate instruction page is opt-in. Custom sheets require a printer or print shop supporting the stated page dimensions.

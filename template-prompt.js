export const wishesPlaceholder='[Describe the recipient or brand, occasion, style, colors, exact wording and anything to avoid.]';
export const templatePrompt=`Design a cohesive premium package using the attached flat box template and my visual references.

Return ONE flat artwork image on the same full landscape canvas. No 3D box, mockup, perspective or presentation board.

Keep every piece exactly where it is, with the same size, shape and folds. Fill printable panels to their edges. Leave pale glue tabs, holes and surrounding margins white.

ORIENTATION
The template labels each panel and shows an UP arrow. This arrow marks the TOP OF THE DESIGN when that panel is viewed from OUTSIDE the assembled box. It does not mean the top of the flat image. Rotate the ENTIRE panel composition together: text, logo and illustration. Opposite walls and lid skirts may need different rotations. Never make every panel upright on the flat canvas.

Keep each main illustration and logo within its own panel, at least 4 mm from cuts and folds. Use only my supplied wording. Preserve the original logo and its proportions. If it cannot be reproduced accurately, leave a clean space for it.

Use the references for a distinctive, consistent style across the package. Before finishing, mentally fold the box and check that every panel reads in the direction of its UP arrow.

Remove ALL guide labels, UP arrows, cut lines and dashed folds from the finished image. Keep the full canvas and white margins. Return the highest available native-resolution PNG, preferably 4096 x 2730. Do not claim 4K if the output is smaller.

MY WISHES
${wishesPlaceholder}`;
export function orientationText(degrees){const a=((Math.round(degrees)%360)+360)%360;if(a===0)return'upright';if(a===180)return'upside down (rotate the entire design 180 degrees)';return a<=180?`rotate the entire design ${a} degrees clockwise`:`rotate the entire design ${360-a} degrees counterclockwise`;}
export function buildTemplatePrompt(manifest,draft='',includeCoordinates=false){
 const clean=draft.replace(/\\\r?\n/g,'\n'),at=clean.indexOf('MY WISHES'),wishes=at>=0?clean.slice(at+9).trim():clean.trim();
 const rows=manifest.panels.filter(p=>!p.glue).map(p=>`${p.piece?p.piece+' / ':''}${p.name}: ${orientationText(p.rotation)}.${p.id==='bottom'?' Underside of the assembled box; follow its own UP arrow.':''}`);
 let map=`PANEL DIRECTIONS\nAngles below are measured from upright on the flat canvas. These are printing orientations, not 3D camera angles.\n${rows.join('\n')}`;
 if(includeCoordinates)map+=`\n\nEXACT GEOMETRY (optional technical reference)\nCanvas ${manifest.width} x ${manifest.height}. Origin: top left. Scale all coordinates together if output resolution differs.\n`+manifest.panels.map(p=>`${p.glue?'Unprinted glue tab':p.name}: ${p.polygons.map(poly=>poly.map(pt=>pt.join(',')).join(' ')).join(' / ')}${p.holes.length?' | white holes: '+JSON.stringify(p.holes):''}`).join('\n');
 return templatePrompt.replace('MY WISHES\n'+wishesPlaceholder,map+'\n\nMY WISHES\n'+(wishes||wishesPlaceholder));
}

const INK="#192E1E";
const hex=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
const mix=(a,b,t)=>'#'+hex(a).map((v,i)=>Math.round(v+(hex(b)[i]-v)*t).toString(16).padStart(2,'0')).join('');
const GLOW = "#EEEBCA", BLOOD = "#B8452E";
const isDark = c => { const [r,g,b] = hex(c); return (.299*r+.587*g+.114*b)/255 < .42; };
const inkOn = bg => isDark(bg) ? "#EEEBCA" : INK;
const rng = seed => () => (seed = (seed*16807) % 2147483647) / 2147483647;
// Hand-drawn style: wobbly ink outlines, big white eyes, heavy lids when spooky, stitched marks.
const SCLERA = "#FBF9EE";
function blobPts(cx, cy, rx, ry, rot = 0, seed = 1, n = 36, wob = .045){
  const c = Math.cos(rot), s = Math.sin(rot), P = [];
  for (let i=0;i<n;i++){ const a = i/n*Math.PI*2, m = 1 + wob*Math.sin(3*a+seed) + wob*.6*Math.sin(5*a+seed*2.3);
    const x = rx*m*Math.cos(a), y = ry*m*Math.sin(a); P.push([cx+x*c-y*s, cy+x*s+y*c]); }
  return P;
}
export function face(g, X, Y, s, S, f){
  if (S.blank) return;
  const sp = S.mood === "spooky", k = f.k || 1, bg = f.bg || S.fur, dk = isDark(bg);
  const ink = dk ? "#EEEBCA" : "#192E1E", lw = .075*s*k;
  const smooth = (P, closed) => {
    const q = P.map(([x,y]) => [X(x), Y(y)]), m = (a,b) => [(a[0]+b[0])/2, (a[1]+b[1])/2];
    g.beginPath();
    if (closed){ const st = m(q[q.length-1], q[0]); g.moveTo(...st); for (let i=0;i<q.length;i++){ const nx = m(q[i], q[(i+1)%q.length]); g.quadraticCurveTo(...q[i], ...nx); } g.closePath(); }
    else { g.moveTo(...q[0]); for (let i=1;i<q.length-1;i++){ const nx = m(q[i], q[i+1]); g.quadraticCurveTo(...q[i], ...nx); } g.lineTo(...q[q.length-1]); }
  };
  // Every ink line is drawn twice, the second pass slightly offset and faint, so it reads as pen on paper.
  const pen = (P, closed, width = lw, color = ink) => {
    g.strokeStyle = color; g.lineWidth = width; smooth(P, closed); g.stroke();
    g.save(); g.globalAlpha = .35; g.translate(.012*s, -.01*s); g.lineWidth = width*.6; smooth(P, closed); g.stroke(); g.restore();
  };
  const fillPen = (P, fill, width = lw) => { g.fillStyle = fill; smooth(P, true); g.fill(); pen(P, true, width); };
  g.save(); g.lineCap = g.lineJoin = "round";

  if (!sp && S.cheeks && f.cheek) for (const sx of [-1,1]){
    const cx = sx*f.cheek[0], cy = f.cheek[1];
    g.fillStyle = "rgba(255,120,75,.38)"; smooth(blobPts(cx, cy, .42*k, .26*k, 0, 3+sx), true); g.fill();
    for (const d of [-.14,0,.14]) pen([[cx+d*k-.05*k, cy-.08*k],[cx+d*k+.05*k, cy+.08*k]], false, lw*.55);
  }

  if (f.eye) for (const sx of [-1,1]){
    const ex = sx*f.eye[0], ey = f.eye[1], seed = 5 + sx;
    let style = S.eyes === "wonky" ? (sx < 0 ? "round" : "small") : S.eyes;
    if (f.carved){
      g.save(); g.shadowColor = "#FF784B"; g.shadowBlur = .35*s;
      const P = style === "tri" || style === "x"
        ? (sp ? [[ex-sx*.62*k,ey+.42*k],[ex+sx*.55*k,ey-.08*k],[ex-sx*.3*k,ey-.45*k]] : [[ex-.55*k,ey-.38*k],[ex+.55*k,ey-.38*k],[ex,ey+.5*k]])
        : blobPts(ex, ey, .42*k, (sp ? .3 : .45)*k, sx*(sp ? -.3 : 0), seed);
      g.fillStyle = GLOW; smooth(P, true); g.fill(); g.restore(); pen(P, true);
      continue;
    }
    if (style === "x"){
      const d = .3*k; pen([[ex-d,ey-d],[ex+d,ey+d]], false, lw*1.2); pen([[ex-d,ey+d],[ex+d,ey-d]], false, lw*1.2); continue;
    }
    const rx = (style === "small" ? .3 : .48)*k, ry = (style === "small" ? .34 : .56)*k;
    const P = style === "tri" ? [[ex-rx*1.1,ey-ry*.7],[ex+rx*1.1,ey-ry*.7],[ex,ey+ry]] : blobPts(ex, ey, rx, ry, sx*.08, seed);
    fillPen(P, style === "glow" ? "#FF9A6E" : SCLERA);
    // Pupils glance up and to the side when cute, and sink low and small when spooky.
    const px = ex + (sp ? -sx*.08 : .12)*k*(rx/.48/k), py = ey + (sp ? -.12 : .08)*ry/.56;
    const pr = (sp ? .1 : .16)*k*(rx/.48/k);
    g.fillStyle = "#192E1E"; g.beginPath(); g.arc(X(px), Y(py), pr*s, 0, Math.PI*2); g.fill();
    if (!sp){ g.fillStyle = SCLERA; g.beginPath(); g.arc(X(px+pr*.35), Y(py+pr*.35), pr*.35*s, 0, Math.PI*2); g.fill(); }
    if (sp){
      // Heavy lid: a shaded cap over the top of the eye, slanting down toward the nose.
      g.save(); smooth(P, true); g.clip();
      const lidY = (x) => ey + ry*(.12 + .28*((x-ex)*sx/rx));
      g.fillStyle = mix(bg, "#192E1E", dk ? .25 : .32);
      g.beginPath(); g.moveTo(X(ex-rx*1.3), Y(ey+ry*1.4)); g.lineTo(X(ex+rx*1.3), Y(ey+ry*1.4));
      g.lineTo(X(ex+rx*1.3), Y(lidY(ex+rx*1.3))); g.lineTo(X(ex-rx*1.3), Y(lidY(ex-rx*1.3))); g.closePath(); g.fill();
      g.restore();
      pen([[ex-rx*.95, lidY(ex-rx*.95)],[ex, lidY(ex)],[ex+rx*.95, lidY(ex+rx*.95)]], false);
      pen([[ex-rx*.7, ey-ry*1.12],[ex, ey-ry*1.22],[ex+rx*.7, ey-ry*1.12]], false, lw*.6);
      g.strokeStyle = "rgba(184,69,46,.7)"; g.lineWidth = lw*.4;
      for (const a of [.2, -.15]){ g.beginPath(); g.moveTo(X(ex+sx*rx*.95), Y(ey+a*ry)); g.lineTo(X(ex+sx*rx*.55), Y(ey+a*ry*.6)); g.stroke(); }
      pen(P, true);
    } else if (style !== "small"){
      for (const t of [.25,.45,.65]){ const a = Math.PI/2 - sx*t; pen([[ex+Math.cos(a)*rx*1.02, ey+Math.sin(a)*ry*1.02],[ex+Math.cos(a)*rx*1.3, ey+Math.sin(a)*ry*1.3]], false, lw*.6); }
    }
  }

  if (f.mouth){
    const [mx, my, mw = 1] = f.mouth, w = mw*k;
    if (S.mouth === "grin"){
      if (f.carved){
        // One carved shape: teeth are notches cut into the lips, so they share the mouth's outline.
        const half = 1.05*w, top = x => my + .15*w - .45*w*(1 - (x/half)**2), bot = x => my + .15*w - .95*w*(1 - (x/half)**2);
        const upper = [], lower = [];
        const notch = (teeth, x) => { for (const [tx, d] of teeth) if (Math.abs(x - tx) <= .12*w) return d; return 0; };
        const xs = []; for (let i=0;i<=60;i++) xs.push(-half + i/60*2*half);
        for (const [tx] of [...upper, ...lower]) xs.push(tx-.12*w, tx-.1199*w, tx+.1199*w, tx+.12*w);
        xs.sort((a,b) => a-b);
        const P = [...xs.map(x => [mx+x, top(x) - notch(upper, x)]), ...xs.slice().reverse().map(x => [mx+x, bot(x) + notch(lower, x)])];
        g.save(); g.shadowColor = "#FF784B"; g.shadowBlur = .35*s; g.fillStyle = GLOW; g.beginPath(); P.forEach(([x,y],i) => i ? g.lineTo(X(x),Y(y)) : g.moveTo(X(x),Y(y))); g.closePath(); g.fill(); g.restore();
        g.strokeStyle = ink; g.lineWidth = lw; g.beginPath(); P.forEach(([x,y],i) => i ? g.lineTo(X(x),Y(y)) : g.moveTo(X(x),Y(y))); g.closePath(); g.stroke();
      } else if (!sp) pen([[mx-.55*w,my+.05*w],[mx-.25*w,my-.22*w],[mx+.25*w,my-.22*w],[mx+.55*w,my+.05*w]], false);
      else pen([[mx-.7*w,my-.15*w],[mx-.3*w,my+.02*w],[mx+.1*w,my-.12*w],[mx+.45*w,my+.04*w],[mx+.7*w,my-.08*w]], false);
    }
    if (S.mouth === "fangs"){
      const curve = sp ? [[mx-.6*w,my-.2*w],[mx,my+.02*w],[mx+.6*w,my-.2*w]] : [[mx-.55*w,my+.02*w],[mx,my-.18*w],[mx+.55*w,my+.02*w]];
      for (const sx of [-1,1]){ const x = sx*.25*w, top = sp ? my-.06*w : my-.12*w, h = (sp ? .42 : .26)*w;
        fillPen([[mx+x-.1*w, top],[mx+x+.1*w, top],[mx+x, top-h]], SCLERA, lw*.7); }
      pen(curve, false);
    }
    if (S.mouth === "stitch"){
      const half = (sp ? .8 : .5)*w, n = sp ? 4 : 3;
      pen([[mx-half,my],[mx-half*.3,my+.05*w],[mx+half*.3,my-.04*w],[mx+half,my+.02*w]], false);
      for (let i=0;i<n;i++){ const x = mx-half + (i+.5)*2*half/n; pen([[x-.1*w,my+.16*w],[x+.1*w,my-.16*w]], false, lw*.8); pen([[x+.1*w,my+.16*w],[x-.1*w,my-.16*w]], false, lw*.8); }
    }
    if (S.mouth === "oh"){
      const P = blobPts(mx, my-(sp ? .35 : .2)*w, (sp ? .24 : .17)*w, (sp ? .42 : .2)*w, 0, 9);
      fillPen(P, "#3A1F1A");
    }
  }
  g.restore();
}
// Sketch marks: little clusters of pen ticks, like the hatching in hand-drawn party cards.

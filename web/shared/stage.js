// Scale a fixed 1920x1080 .stage to fit the window (letterboxed, centred).
export function fitStage(stage) {
  const fit = () => {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    stage.style.transform = `translate(${(innerWidth - 1920 * s) / 2}px, ${(innerHeight - 1080 * s) / 2}px) scale(${s})`;
  };
  addEventListener('resize', fit);
  fit();
}

export function toast(text, ms = 2500) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.querySelector('.stage').appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

export function fatal(html) {
  const el = document.createElement('div');
  el.className = 'fatal';
  el.innerHTML = html;
  document.querySelector('.stage').appendChild(el);
}

export async function fetchRom() {
  const r = await fetch('/rom');
  if (!r.ok) throw new Error('rom');
  return new Uint8Array(await r.arrayBuffer());
}

export async function loadImage(url) {
  return new Promise((ok) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => ok(null);
    img.src = url;
  });
}

export const fmt = (n) => n.toLocaleString('en-US');

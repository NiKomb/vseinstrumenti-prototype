const slides = [...document.querySelectorAll('.slide')];
const viewport = document.getElementById('viewport');
const viewer = document.querySelector('.viewer');
const stage = document.getElementById('stage');
const count = document.getElementById('count');
const previous = document.getElementById('previous');
const next = document.getElementById('next');
const contents = document.getElementById('contents');
const toggle = document.getElementById('contents-toggle');
const contentsList = document.getElementById('contents-list');
const progress = document.getElementById('progress');
const fullscreen = document.getElementById('fullscreen');
let current = -1;
let selected = 0;
let selection = 0;
let arrowFrame = 0;

// Successful decodes are reusable; failures are deliberately evicted for revisits.
const resources = new Map();
const preparations = new Map();
function decodeResource(url, priority) {
  let resource = resources.get(url);
  if (!resource) {
    const image = new Image();
    image.fetchPriority = priority;
    image.src = url;
    resource = { image, promise: image.decode().then(() => true, () => {
      resources.delete(url);
      return false;
    }) };
    resources.set(url, resource);
  }
  if (priority === 'high') resource.image.fetchPriority = priority;
  return resource.promise;
}

function prepare(index, priority) {
  const slide = slides[index];
  if (!slide) return Promise.resolve();
  // Promote a neighbouring slide if it becomes the selected destination.
  if (priority === 'high') {
    slide.querySelectorAll('img').forEach(image => { image.fetchPriority = priority; });
  }
  if (preparations.has(index)) return preparations.get(index);
  const images = [...slide.querySelectorAll('img')].map(async image => {
    image.fetchPriority = priority;
    image.loading = 'eager';
    if (image.complete && !image.naturalWidth) {
      const source = image.getAttribute('src');
      image.removeAttribute('src');
      image.setAttribute('src', source);
    }
    try { await image.decode(); return true; }
    catch { return false; }
  });
  // SVG <image> has no decode(): decode the same unmodified URL with an Image.
  for (const image of slide.querySelectorAll('image')) {
    const source = image.getAttribute('href');
    const url = new URL(source, document.baseURI).href;
    images.push(decodeResource(url, priority).then(ready => {
      if (!ready) return false;
      // Also wait for the SVG consumer, including a fresh attempt after an error.
      return new Promise(resolve => {
        const finish = event => {
          image.removeEventListener('load', finish);
          image.removeEventListener('error', finish);
          if (event.type === 'error') resources.delete(url);
          resolve(event.type === 'load');
        };
        image.addEventListener('load', finish);
        image.addEventListener('error', finish);
        image.removeAttribute('href');
        image.setAttribute('href', source);
      });
    }));
  }
  const fonts = new Map();
  for (const element of [slide, ...slide.querySelectorAll('*')]) {
    const style = getComputedStyle(element);
    for (const match of style.backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      images.push(decodeResource(new URL(match[1], document.baseURI).href, priority));
    }
    if ([...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) {
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      fonts.set(font, (fonts.get(font) || '') + element.textContent);
    }
  }
  const ready = Promise.all([
    Promise.all(images),
    Promise.all([...fonts].map(([font, text]) => document.fonts.load(font, text)))
      .catch(() => {}).then(() => document.fonts.ready),
  ]).then(([results]) => {
    if (results.some(result => !result)) preparations.delete(index);
  });
  preparations.set(index, ready);
  return ready;
}

// Bind Russian prepositions, short conjunctions and particles to the next word.
for (const slide of slides) {
  const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    node.textContent = node.textContent.replace(
      /(?<![\p{L}\p{N}-])(а|и|или|но|не|ни|без|в|во|для|до|за|из|из-за|из-под|к|ко|между|на|над|о|об|обо|от|перед|по|под|при|про|с|со|у|через)[ \t]+(?=\S|$)/giu,
      '$1\u00a0',
    );
  }
}

// Keep annotations outside the screenshot, anchored to its original SVG coordinates.
function drawFocusArrows(slide) {
  slide.querySelector('.focus-arrows')?.remove();
  const targets = [...slide.querySelectorAll('.focus-target')];
  if (!targets.length) return;
  const namespace = 'http://www.w3.org/2000/svg';
  const overlay = document.createElementNS(namespace, 'svg');
  overlay.classList.add('focus-arrows');
  overlay.setAttribute('aria-hidden', 'true');
  const tokens = getComputedStyle(slide);
  const width = parseFloat(tokens.getPropertyValue('--deck-width'));
  const height = parseFloat(tokens.getPropertyValue('--deck-height'));
  const arrowWidth = parseFloat(tokens.getPropertyValue('--deck-focus-arrow-width'));
  const arrowHeight = parseFloat(tokens.getPropertyValue('--deck-focus-arrow-height'));
  const headWidth = parseFloat(tokens.getPropertyValue('--deck-focus-head-width'));
  const headHeight = parseFloat(tokens.getPropertyValue('--deck-focus-head-height'));
  overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const bounds = slide.getBoundingClientRect();
  for (const target of targets) {
    const svg = target.ownerSVGElement;
    const point = svg.createSVGPoint();
    point.x = target.cx.baseVal.value;
    point.y = target.cy.baseVal.value;
    const screen = point.matrixTransform(svg.getScreenCTM());
    const x = (screen.x - bounds.x) * width / bounds.width;
    const y = (screen.y - bounds.y) * height / bounds.height;
    const direction = target.dataset.focusDirection === 'left' ? -1 : 1;
    const line = document.createElementNS(namespace, 'path');
    line.classList.add('focus-arrow-line');
    line.setAttribute('d', `M ${x - direction * arrowWidth} ${y - arrowHeight} C ${x - direction * arrowWidth} ${y}, ${x - direction * arrowWidth} ${y}, ${x - direction * headWidth} ${y}`);
    const head = document.createElementNS(namespace, 'path');
    head.classList.add('focus-arrow-head');
    head.setAttribute('d', `M ${x - direction * headWidth} ${y - headHeight / 2} L ${x} ${y} L ${x - direction * headWidth} ${y + headHeight / 2} Z`);
    overlay.append(line, head);
  }
  slide.append(overlay);
}

function queueFocusArrows() {
  cancelAnimationFrame(arrowFrame);
  arrowFrame = requestAnimationFrame(() => {
    if (matchMedia('print').matches) slides.forEach(drawFocusArrows);
    else if (current >= 0) drawFocusArrows(slides[current]);
  });
}

slides.forEach((slide, index) => {
  const item = document.createElement('li');
  const button = document.createElement('button');
  const number = document.createElement('span');
  const title = document.createElement('span');
  number.textContent = String(index + 1).padStart(2, '0');
  title.textContent = slide.dataset.title;
  button.append(number, title);
  button.addEventListener('click', () => show(index));
  item.append(button);
  contentsList.append(item);
  const segment = document.createElement('button');
  segment.setAttribute('aria-label', `Слайд ${index + 1}: ${slide.dataset.title}`);
  segment.addEventListener('click', () => show(index));
  progress.append(segment);
});

async function show(index, updateHash = true) {
  selected = Math.max(0, Math.min(slides.length - 1, index));
  const target = selected;
  const request = ++selection;
  previous.disabled = selected === 0;
  next.disabled = selected === slides.length - 1;
  if (updateHash) history.replaceState(null, '', `#${selected + 1}`);
  await prepare(target, 'high');
  if (request !== selection) return;
  current = target;
  slides.forEach((slide, i) => {
    slide.hidden = i !== current;
    contentsList.children[i].firstElementChild.setAttribute('aria-current', String(i === current));
    progress.children[i].setAttribute('aria-current', String(i === current));
  });
  count.textContent = `${String(current + 1).padStart(2, '0')} / ${slides.length}`;
  queueFocusArrows();
  // Warm neighbours after committing the slide, without delaying navigation.
  requestAnimationFrame(() => {
    if (request !== selection) return;
    prepare(current - 1, 'low');
    prepare(current + 1, 'low');
  });
}

function readHash() {
  const value = Number(location.hash.slice(1));
  show(Number.isInteger(value) && value > 0 ? value - 1 : 0, false);
}

function resize() {
  const style = getComputedStyle(viewport);
  const width = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const tokens = getComputedStyle(stage);
  const slideWidth = parseFloat(tokens.getPropertyValue('--deck-width'));
  const slideHeight = parseFloat(tokens.getPropertyValue('--deck-height'));
  const maximumScale = document.fullscreenElement === viewer ? Infinity : 1;
  stage.style.setProperty('--deck-slide-scale', String(Math.max(.01, Math.min(width / slideWidth, height / slideHeight, maximumScale))));
  queueFocusArrows();
}

previous.addEventListener('click', () => show(selected - 1));
next.addEventListener('click', () => show(selected + 1));
// COMMON: tap either half of the viewing area, including space around the slide.
// Use the resulting click once for both touch and mouse; drags and pinch gestures
// must not turn pages, and links keep their own actions.
let tap = null;
const interactive = target => target.closest('a, button, input, textarea, select, [contenteditable], [role="button"]');
viewport.addEventListener('pointerdown', event => {
  tap = event.isPrimary && event.button === 0 && !interactive(event.target)
    ? { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
    : null;
});
viewport.addEventListener('pointermove', event => {
  if (tap?.id === event.pointerId && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10) tap.moved = true;
});
viewport.addEventListener('pointercancel', () => { tap = null; });
viewport.addEventListener('click', event => {
  const gesture = tap;
  tap = null;
  if (!gesture || gesture.moved || event.button !== 0 || event.defaultPrevented || interactive(event.target) || window.getSelection()?.toString()) return;
  if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) return;
  const bounds = viewport.getBoundingClientRect();
  show(selected + (event.clientX < bounds.left + bounds.width / 2 ? -1 : 1));
});
toggle.addEventListener('click', () => {
  contents.hidden = !contents.hidden;
  toggle.setAttribute('aria-expanded', String(!contents.hidden));
});
fullscreen.addEventListener('click', async () => {
  fullscreen.disabled = true;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await viewer.requestFullscreen();
  } catch {
    fullscreen.textContent = 'Полный экран недоступен';
    fullscreen.setAttribute('aria-label', fullscreen.textContent);
  } finally {
    fullscreen.disabled = false;
  }
});
document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === viewer;
  fullscreen.setAttribute('aria-pressed', String(active));
  fullscreen.textContent = active ? 'Выйти из полного экрана' : 'Полный экран';
  fullscreen.setAttribute('aria-label', fullscreen.textContent);
  contents.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  if (active) viewport.focus({ preventScroll: true });
  else fullscreen.focus({ preventScroll: true });
  requestAnimationFrame(resize);
});
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.altKey || event.metaKey || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (['ArrowRight', 'PageDown'].includes(event.key) || (event.key === ' ' && (event.target === document.body || document.fullscreenElement === viewer))) {
    event.preventDefault(); show(selected + 1);
  } else if (['ArrowLeft', 'PageUp'].includes(event.key)) {
    event.preventDefault(); show(selected - 1);
  } else if (event.key === 'Home') {
    event.preventDefault(); show(0);
  } else if (event.key === 'End') {
    event.preventDefault(); show(slides.length - 1);
  } else if (event.key === 'Escape') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (!contents.hidden) {
      contents.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }
  }
});
window.addEventListener('hashchange', readHash);
new ResizeObserver(resize).observe(viewport);
document.fonts.ready.then(resize);
window.addEventListener('load', resize);
matchMedia('print').addEventListener('change', queueFocusArrows);
window.addEventListener('beforeprint', () => slides.forEach(drawFocusArrows));
readHash();
resize();

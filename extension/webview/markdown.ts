// Small, safe markdown → DOM renderer (no innerHTML of untrusted text).

export type MdOptions = { onPath?(p: string): void; onLink?(url: string): void };

const PATHLIKE = /^(?:[\w@.-]+[\\/])*[\w@.-]+\.[a-z0-9]{1,8}(?::\d+)?$/i;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w])_([^_\n]+?)_(?![\w])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(\n)/g;

export function inline(parent: HTMLElement, text: string, o: MdOptions = {}): void {
  // own regex instance per call: inline() recurses (bold/italic), and a shared /g regex would reset the outer loop
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== undefined) {
      const code = el("code");
      const v = m[2].trim();
      code.textContent = v;
      if (o.onPath && PATHLIKE.test(v) && /[./\\]/.test(v)) {
        code.className = "path";
        code.tabIndex = 0;
        code.title = "Otvori fajl";
        const go = () => o.onPath!(v);
        code.addEventListener("click", go);
        code.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      }
      parent.append(code);
    } else if (m[3] !== undefined) {
      const b = el("strong");
      inline(b, m[3], o);
      parent.append(b);
    } else if (m[4] !== undefined || m[5] !== undefined) {
      const i = el("em");
      inline(i, (m[4] ?? m[5])!, o);
      parent.append(i);
    } else if (m[6] !== undefined) {
      const a = el("a");
      a.textContent = m[6];
      a.href = m[7];
      a.addEventListener("click", (e) => { e.preventDefault(); o.onLink?.(m![7]); });
      parent.append(a);
    } else if (m[8] !== undefined) {
      parent.append(el("br"));
    }
  }
  if (last < text.length) parent.append(text.slice(last));
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function renderMarkdown(src: string, o: MdOptions = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const p = el("p");
    inline(p, para.join("\n"), o);
    frag.append(p);
    para.length = 0;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++;
      const pre = el("pre", "code-block");
      if (fence[2]) pre.dataset.lang = fence[2];
      const code = el("code");
      code.textContent = buf.join("\n");
      pre.append(code);
      frag.append(pre);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      flush();
      const h = el(hm[1].length <= 2 ? "h3" : "h4");
      inline(h, hm[2], o);
      frag.append(h);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); frag.append(el("hr")); i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      const q = el("blockquote");
      q.append(renderMarkdown(buf.join("\n"), o));
      frag.append(q);
      continue;
    }
    const lm = line.match(LIST);
    if (lm) {
      flush();
      const list = el(/\d/.test(lm[2]) ? "ol" : "ul");
      while (i < lines.length) {
        const m = lines[i].match(LIST);
        if (m) {
          const li = el("li");
          if (m[1].length >= 2) li.className = "nested";
          inline(li, m[3], o);
          list.append(li);
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]) && list.lastElementChild) {
          const li = list.lastElementChild as HTMLElement;
          li.append(el("br"));
          inline(li, lines[i].trim(), o);
          i++;
        } else break;
      }
      frag.append(list);
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return frag;
}

// Минимальный разбор XML в дерево {name, attrs, children, text} — для правил КД2 (до десятков МБ).
// Поддерживает комментарии, CDATA, инструкции <?…?>, самозакрывающиеся теги, сущности.
'use strict';
const { attrs: parseAttrs, unescapeXml } = require('./rules');

function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=>]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const el = { name: m[3], attrs: parseAttrs(m[4]), children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6]) top.text += unescapeXml(m[6]);
  }
  return root;
}

const kids = (el, name) => (el ? el.children.filter(c => c.name === name) : []);
const kid = (el, name) => (el ? el.children.find(c => c.name === name) : null);
const txt = (el, name) => { const c = kid(el, name); return c ? c.text.trim() : null; };

module.exports = { parseXml, kids, kid, txt };

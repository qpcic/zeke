import type { Embed } from './embed.ts';

/** Offline Discord-look-alike preview page for a list of messages (dark theme). */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function md(s: string): string {
  const parts = s.split(/```\n?/);
  return parts
    .map((p, i) =>
      i % 2 === 1
        ? `<pre>${esc(p.replace(/\n$/, ''))}</pre>`
        : esc(p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>'),
    )
    .join('');
}

const hex = (n?: number) => `#${(n ?? 0x4f545c).toString(16).padStart(6, '0')}`;

function embedHtml(e: Embed): string {
  const fields = (e.fields ?? []).map((f) => `<div class="f ${f.inline ? 'inl' : ''}"><div class="fn">${md(f.name)}</div><div class="fv">${md(f.value)}</div></div>`).join('');
  const foot = [e.footer?.text, e.timestamp ? new Date(e.timestamp).toLocaleString('en-GB') : ''].filter((x): x is string => !!x).map(esc).join(' • ');
  return `<div class="embed" style="border-left-color:${hex(e.color)}">
    <div class="body">
      ${e.author ? `<div class="author">${esc(e.author.name)}</div>` : ''}
      ${e.title ? `<div class="title">${e.url ? `<a href="${esc(e.url)}" target="_blank">${esc(e.title)}</a>` : esc(e.title)}</div>` : ''}
      ${e.description ? `<div class="desc">${md(e.description)}</div>` : ''}
      ${fields ? `<div class="fields">${fields}</div>` : ''}
      ${foot ? `<div class="foot">${foot}</div>` : ''}
    </div>
    ${e.thumbnail ? `<img class="thumb" src="${esc(e.thumbnail.url)}" alt="">` : ''}
  </div>`;
}

export interface PreviewMessage { at: number; channel: string; embeds: Embed[] }

export function renderPreviewPage(messages: PreviewMessage[]): string {
  const body = messages
    .map((m) => `<div class="msg"><div class="avatar">Z</div><div class="content"><div class="hdr"><span class="name">Zeke</span><span class="bot">APP</span><span class="time">#${esc(m.channel)} · ${new Date(m.at).toLocaleString('en-GB')}</span></div>${m.embeds.map(embedHtml).join('')}</div></div>`)
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Zeke preview</title><style>
  body{background:#313338;color:#dbdee1;font:16px/1.375 "gg sans","Noto Sans",Helvetica,Arial,sans-serif;margin:0;padding:16px}
  .msg{display:flex;gap:16px;padding:8px 16px}
  .avatar{width:40px;height:40px;border-radius:50%;background:#5865f2;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}
  .hdr{margin-bottom:4px}.name{color:#f2f3f5;font-weight:600}.bot{background:#5865f2;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;margin:0 6px;vertical-align:2px}.time{color:#949ba4;font-size:12px}
  .embed{display:flex;max-width:520px;background:#2b2d31;border-left:4px solid;border-radius:4px;padding:8px 16px 16px 12px;margin-top:4px;gap:16px}
  .body{flex:1;min-width:0}.author{font-size:14px;font-weight:600;color:#f2f3f5;margin-top:8px}
  .title{font-weight:600;color:#f2f3f5;margin-top:8px}.title a{color:#00a8fc;text-decoration:none}
  .desc{font-size:14px;margin-top:8px}.fields{display:flex;flex-wrap:wrap;margin-top:8px;gap:8px 0}
  .f{flex:1 1 100%;font-size:14px}.f.inl{flex:1 1 30%;min-width:120px}.fn{font-weight:600;color:#f2f3f5;margin-bottom:2px}
  pre{background:#1e1f22;border:1px solid #1e1f22;border-radius:4px;padding:7px;margin:4px 0 0;font:13px/1.3 Consolas,"Andale Mono",monospace;overflow-x:auto;white-space:pre}
  code{background:#1e1f22;padding:0 3px;border-radius:3px;font:85% Consolas,monospace}
  .foot{font-size:12px;color:#b5bac1;margin-top:8px}.thumb{width:80px;height:80px;border-radius:4px;margin-top:8px;flex:none;object-fit:cover}
  </style></head><body>${body || '<p style="color:#949ba4">No messages yet.</p>'}</body></html>`;
}

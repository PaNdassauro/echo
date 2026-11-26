import { Fragment, type ReactNode } from "react";
import { ExternalLink, FileText, ImageIcon, List, Phone, Reply, Video } from "lucide-react";
import { fillExamples, headerMediaFor, orderedButtons, type TemplateDraft } from "@/lib/templateBuilder";

/** *negrito*, _itálico_, ~riscado~ e `mono`, como o WhatsApp desenha. */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Como no WhatsApp: o marcador só vale colado no texto e fora de palavra
  // (`2 * 3 * 4` e `minha_reserva_vip` ficam como estão). O caractere anterior vai
  // num grupo em vez de lookbehind, que derruba o Safari anterior ao 16.4.
  const re = /(^|[^\p{L}\p{N}])(\*[^\s*](?:[^*\n]*[^\s*])?\*|_[^\s_](?:[^_\n]*[^\s_])?_|~[^\s~](?:[^~\n]*[^\s~])?~|```[^`]+```)(?=$|[^\p{L}\p{N}])/gu;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const idx = m.index + m[1].length;
    if (idx > last) out.push(text.slice(last, idx));
    const token = m[2];
    const inner = token.startsWith("```") ? token.slice(3, -3) : token.slice(1, -1);
    const key = `f${i++}`;
    if (token.startsWith("*")) out.push(<strong key={key}>{inner}</strong>);
    else if (token.startsWith("_")) out.push(<em key={key}>{inner}</em>);
    else if (token.startsWith("~")) out.push(<s key={key}>{inner}</s>);
    else out.push(<code key={key} className="font-mono">{inner}</code>);
    last = idx + token.length;
    // O fechamento de um marcador pode ser o "antes" do próximo (*a*_b_).
    re.lastIndex = last - 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const MEDIA_ICON = { IMAGE: ImageIcon, VIDEO: Video, DOCUMENT: FileText } as const;

/** Prévia em bolha de WhatsApp, com os exemplos no lugar das variáveis. */
export default function TemplatePreview({ draft }: { draft: TemplateDraft }) {
  const body = fillExamples(draft.body, draft.examples);
  const MediaIcon = draft.headerType in MEDIA_ICON ? MEDIA_ICON[draft.headerType as keyof typeof MEDIA_ICON] : null;
  const imageLink = draft.headerType === "IMAGE" ? headerMediaFor(draft)?.link : undefined;
  const all = orderedButtons(draft);
  // Mais de 3: o WhatsApp mostra 2 e "Ver todas as opções".
  const collapsed = all.length > 3;
  const ordered = collapsed ? all.slice(0, 2) : all;

  return (
    <div className="rounded-xl bg-[#efeae2] dark:bg-[#0b141a] p-3">
      <div className="max-w-[300px] rounded-lg rounded-tl-none bg-white dark:bg-[#202c33] text-[#111b21] dark:text-[#e9edef] shadow-sm overflow-hidden">
        {MediaIcon && (
          imageLink ? (
            <img src={imageLink} alt="" className="m-1 mb-0 aspect-[1.91/1] w-[calc(100%-0.5rem)] rounded-md object-cover" />
          ) : (
            <div className="m-1 mb-0 flex aspect-[1.91/1] items-center justify-center rounded-md bg-black/5 dark:bg-white/5">
              <MediaIcon className="h-8 w-8 opacity-40" aria-hidden />
            </div>
          )
        )}
        <div className="px-2.5 pt-1.5 pb-1 text-sm leading-snug">
          {draft.headerType === "TEXT" && draft.headerText.trim() && (
            <p className="font-semibold mb-1 break-words">{draft.headerText}</p>
          )}
          {body.trim() ? (
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {body.split("\n").map((line, i, arr) => (
                <Fragment key={i}>
                  {renderInline(line)}
                  {i < arr.length - 1 && "\n"}
                </Fragment>
              ))}
            </p>
          ) : (
            <p className="text-[#667781] dark:text-[#8696a0] italic">Sua mensagem aparece aqui.</p>
          )}
          {draft.footer.trim() && (
            <p className="mt-1 text-xs text-[#667781] dark:text-[#8696a0] break-words">{draft.footer}</p>
          )}
          <p className="text-right text-[11px] text-[#667781] dark:text-[#8696a0] tabular-nums">10:30</p>
        </div>
        {ordered.length > 0 && (
          <div className="divide-y divide-black/10 dark:divide-white/10 border-t border-black/10 dark:border-white/10">
            {ordered.map((b) => {
              const Icon = b.type === "URL" ? ExternalLink : b.type === "PHONE_NUMBER" ? Phone : Reply;
              return (
                <div
                  key={b.key}
                  className="flex items-center justify-center gap-1.5 py-2 text-sm font-medium text-[#027eb5] dark:text-[#53bdeb]"
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  <span className="truncate">{b.text.trim() || "Botão"}</span>
                </div>
              );
            })}
            {collapsed && (
              <div className="flex items-center justify-center gap-1.5 py-2 text-sm font-medium text-[#027eb5] dark:text-[#53bdeb]">
                <List className="h-3.5 w-3.5" aria-hidden />
                <span>Ver todas as opções</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

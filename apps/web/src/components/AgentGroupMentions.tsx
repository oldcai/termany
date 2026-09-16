import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import type { AgentConversation } from "../state/store";
import { useI18n } from "../i18n";
import { useNativeOccluder } from "../nativeViewOcclusion";
import { AgentAvatar } from "./AgentIdentityFields";

export interface AgentGroupMentionsHandle {
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export const AgentGroupMentions = forwardRef<AgentGroupMentionsHandle, {
  id: string;
  query: string;
  members: AgentConversation[];
  getMemberIcon: (member: AgentConversation) => string | undefined;
  includeEveryone?: boolean;
  title?: string;
  onSelect: (name: string) => void;
  onDismiss: () => void;
}>(function AgentGroupMentions({ id, query, members, getMemberIcon, includeEveryone = true, title, onSelect, onDismiss }, ref) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(0);
  const panelRef = useNativeOccluder<HTMLDivElement>(id, true);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  const options = [
    ...(includeEveryone
      ? [{ id: "all", name: "all", label: t("agentGroup.everyone"), member: undefined as AgentConversation | undefined }]
      : []),
    ...members.map((member) => ({ id: member.id, name: member.title, label: member.title, member })),
  ].filter((option) => `${option.label} ${option.name}`.normalize("NFKC").toLocaleLowerCase().includes(normalized));
  const active = Math.min(selected, Math.max(0, options.length - 1));
  useEffect(() => setSelected(0), [query]);
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: "nearest" }); }, [active]);
  useImperativeHandle(ref, () => ({
    handleKeyDown: (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return true;
      }
      if (!options.length) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
        return true;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        onSelect(options[active].name);
        return true;
      }
      return false;
    },
  }));
  return (
    <div className="agent-mentions" ref={panelRef}>
      <div className="agent-mentions-title">{title ?? t("agentGroup.mentionMember")}</div>
      <div id={id} role="listbox" aria-label={title ?? t("agentGroup.mentionMember")}>
        {options.map((option, index) => (
          <button key={option.id} type="button" role="option" aria-selected={active === index}
            ref={active === index ? selectedRef : undefined} tabIndex={-1}
            className="agent-mention-option" onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setSelected(index)} onClick={() => onSelect(option.name)}>
            {option.member
              ? <AgentAvatar avatar={option.member.agentAvatar} icon={getMemberIcon(option.member)} />
              : <span className="agent-mention-all">@</span>}
            <span>{option.label}</span>
          </button>
        ))}
        {!options.length && <div className="agent-mentions-empty">{t("agentGroup.noMemberMatch")}</div>}
      </div>
    </div>
  );
});

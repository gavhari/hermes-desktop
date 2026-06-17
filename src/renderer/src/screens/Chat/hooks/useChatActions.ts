import { useCallback, useEffect, useRef } from "react";
import type { ChatInputHandle } from "../ChatInput";
import { createTurn, shouldSendToAgent } from "../chatMessages";
import type { SlashExecOutcome } from "../slashExec";
import type { ActiveTurn, Attachment, ChatMessage } from "../types";

interface LocalCommands {
  isLocal: (text: string) => boolean;
  executeLocal: (text: string) => Promise<boolean>;
}

interface UseChatActionsArgs {
  /** This conversation's run id — threaded to the main process so its events
   *  are tagged and its abort targets only this run. */
  runId: string;
  profile?: string;
  hermesSessionId: string | null;
  messages: ChatMessage[];
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  onSessionStarted?: () => void;
  chatInputRef: React.RefObject<ChatInputHandle | null>;
  localCommands: LocalCommands;
  activeTurnRef: React.MutableRefObject<ActiveTurn | null>;
  /** Working folder bound to this conversation (issue #27), or null. */
  contextFolder: string | null;
  sendViaDashboard?: (
    text: string,
    attachments?: Attachment[],
  ) => Promise<boolean>;
  /** Run a slash command through the gateway's slash pipeline (dashboard
   *  transport only). Undefined on the legacy transport, where slash commands
   *  fall back to being sent as plain text. */
  execSlashViaDashboard?: (
    command: string,
    sys: (text: string) => void,
  ) => Promise<SlashExecOutcome>;
  /** Render an agent/system message into the transcript (slash output). */
  addAgentMessage?: (content: string) => void;
  abortDashboard?: () => void;
}

interface UseChatActionsResult {
  handleSend: (
    text: string,
    attachments?: Attachment[],
    skipLoadingCheck?: boolean,
  ) => Promise<void>;
  handleQuickAsk: (text: string, attachments?: Attachment[]) => Promise<void>;
  handleAbort: () => void;
  handleApprove: () => void;
  handleDeny: () => void;
}

/**
 * Encapsulates the chat's user-facing actions (send, quick-ask, abort,
 * approve, deny). All returned callbacks have stable identities so that
 * memoized children don't re-render on every streaming chunk — `messages`
 * and `isLoading` are read via live refs that update via `useEffect`.
 */
// @lat: [[chat-commands#Slash command execution#Local vs gateway commands]]
export function useChatActions({
  runId,
  profile,
  hermesSessionId,
  messages,
  isLoading,
  setIsLoading,
  setMessages,
  onSessionStarted,
  chatInputRef,
  localCommands,
  activeTurnRef,
  contextFolder,
  sendViaDashboard,
  execSlashViaDashboard,
  addAgentMessage,
  abortDashboard,
}: UseChatActionsArgs): UseChatActionsResult {
  const messagesRef = useRef(messages);
  const isLoadingRef = useRef(isLoading);
  useEffect(() => {
    messagesRef.current = messages;
    isLoadingRef.current = isLoading;
  });

  const pushUser = useCallback(
    (content: string, idPrefix = "user", attachments?: Attachment[]) => {
      const turn = createTurn(idPrefix);
      setMessages((prev) => [
        ...prev,
        {
          id: turn.userId,
          role: "user",
          content,
          turnId: turn.turnId,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        },
      ]);
      return turn;
    },
    [setMessages],
  );

  const sendToAgent = useCallback(
    async (text: string, attachments?: Attachment[]): Promise<void> => {
      try {
        if (sendViaDashboard) {
          const handled = await sendViaDashboard(text, attachments);
          if (handled) return;
        }
        await window.hermesAPI.sendMessage(
          text,
          profile,
          hermesSessionId || undefined,
          messagesRef.current.filter(shouldSendToAgent).map((m) => ({
            role: m.role,
            content: m.content,
          })),
          attachments,
          contextFolder ?? undefined,
          runId,
        );
      } catch {
        // onChatError IPC already surfaces this to the user
      }
    },
    [runId, profile, hermesSessionId, contextFolder, sendViaDashboard],
  );

  const handleSend = useCallback(
    async (
      text: string,
      attachments?: Attachment[],
      skipLoadingCheck = false,
    ): Promise<void> => {
      const hasPayload = text.length > 0 || (attachments?.length ?? 0) > 0;
      if (!hasPayload) return;
      if (!skipLoadingCheck && isLoadingRef.current) return;

      if (text && localCommands.isLocal(text)) {
        const cmd = text.split(/\s+/)[0].toLowerCase();
        if (cmd !== "/new" && cmd !== "/clear") pushUser(text);
        await localCommands.executeLocal(text);
        return;
      }

      // Non-local slash command on the dashboard transport: route through the
      // gateway's slash.exec / command.dispatch pipeline instead of submitting
      // the literal text to the model (which would just echo it back as prose).
      // A `send` outcome means the command resolved to an agent prompt, so we
      // run a normal streaming turn with it. Skipped on the legacy transport
      // (execSlashViaDashboard undefined) and for slash text with attachments.
      if (
        execSlashViaDashboard &&
        text.startsWith("/") &&
        (attachments?.length ?? 0) === 0
      ) {
        const startIndex = messagesRef.current.length;
        const turn = pushUser(text);
        setIsLoading(true);
        const outcome = await execSlashViaDashboard(
          text,
          addAgentMessage ?? (() => {}),
        );
        if (outcome.kind === "send") {
          activeTurnRef.current = { ...turn, startIndex, status: "running" };
          onSessionStarted?.();
          await sendToAgent(outcome.message);
          return; // streaming-done clears the loading state
        }
        if (outcome.kind === "error") {
          addAgentMessage?.(`error: ${outcome.message}`);
        }
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      const turn = pushUser(text, "user", attachments);
      activeTurnRef.current = {
        ...turn,
        startIndex: messagesRef.current.length,
        status: "running",
      };
      onSessionStarted?.();
      await sendToAgent(text, attachments);
    },
    [
      activeTurnRef,
      localCommands,
      execSlashViaDashboard,
      addAgentMessage,
      pushUser,
      onSessionStarted,
      sendToAgent,
      setIsLoading,
    ],
  );

  const handleQuickAsk = useCallback(
    async (text: string, attachments?: Attachment[]): Promise<void> => {
      if (!text || isLoadingRef.current) return;
      setIsLoading(true);
      const turn = pushUser(`💭 ${text}`, "user-btw", attachments);
      activeTurnRef.current = {
        ...turn,
        startIndex: messagesRef.current.length,
        status: "running",
      };
      await sendToAgent(`/btw ${text}`, attachments);
    },
    [activeTurnRef, pushUser, sendToAgent, setIsLoading],
  );

  const handleAbort = useCallback(() => {
    abortDashboard?.();
    window.hermesAPI.abortChat(runId);
    activeTurnRef.current = null;
    setIsLoading(false);
    setTimeout(() => chatInputRef.current?.focus(), 50);
  }, [abortDashboard, runId, activeTurnRef, chatInputRef, setIsLoading]);

  const handleApprove = useCallback(() => {
    chatInputRef.current?.clear();
    setIsLoading(true);
    const turn = pushUser("/approve", "user-approve");
    activeTurnRef.current = {
      ...turn,
      startIndex: messagesRef.current.length,
      status: "running",
    };
    sendToAgent("/approve").catch(() => setIsLoading(false));
  }, [activeTurnRef, chatInputRef, pushUser, sendToAgent, setIsLoading]);

  const handleDeny = useCallback(() => {
    chatInputRef.current?.clear();
    setIsLoading(true);
    const turn = pushUser("/deny", "user-deny");
    activeTurnRef.current = {
      ...turn,
      startIndex: messagesRef.current.length,
      status: "running",
    };
    sendToAgent("/deny").catch(() => setIsLoading(false));
  }, [activeTurnRef, chatInputRef, pushUser, sendToAgent, setIsLoading]);

  return { handleSend, handleQuickAsk, handleAbort, handleApprove, handleDeny };
}

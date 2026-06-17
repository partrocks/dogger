import { useEffect, useRef, useState } from "react";
import {
    PaperAirplaneIcon,
    SparklesIcon,
    StopIcon,
} from "@heroicons/react/24/outline";
import type { Project, Task } from "../types";
import * as api from "../api";
import { AI_MODELS } from "../api";

// A single piece of tool activity within an assistant turn. The backend emits a
// `running` event then a `done`/`error` event for each tool call; we collapse
// the pair into one line that updates in place.
interface ToolActivity {
    key: number;
    tool: string;
    summary: string;
    phase: "running" | "done" | "error";
}

// One rendered chat bubble. Assistant turns additionally carry the tool
// activity observed while streaming and a status used for styling.
interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    text: string;
    tools: ToolActivity[];
    status: "streaming" | "done" | "error" | "cancelled";
    error?: string;
}

function newId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Whether an error message is about the OpenAI token, so we can offer a direct
// route to Settings. Covers both the missing-token guard and a rejected key.
function isTokenError(message: string | undefined): boolean {
    return !!message && /token/i.test(message);
}

// The "Generate" tab: a Cursor-style agent chat. The agent loop runs in Rust
// (keeping the API token off the frontend); progress arrives as `ai-*` events.
// Listeners are attached *before* invoking `generateTask` — and torn down when
// the generation ends or the component unmounts — so no early output is missed.
// Chat state is intentionally ephemeral: it lives only for as long as the tab
// is mounted (a deliberate v1 decision — see the plan).
export function GenerateTab({
    project,
    task,
    onGenerated,
}: {
    project: Project;
    task: Task;
    onGenerated: () => void;
}) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(AI_MODELS[0]?.id ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Configuration notices, resolved once on mount.
    const [hasToken, setHasToken] = useState<boolean | null>(null);
    const hasCodebase = !!project.codebasePath.trim();

    const threadRef = useRef<HTMLDivElement | null>(null);
    // Unlisten callbacks for the in-flight generation, cleared on finish.
    const unlistenRef = useRef<Array<() => void>>([]);
    // The genId of the in-flight generation, so the Stop button can cancel it.
    const genIdRef = useRef<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        api.getSettings()
            .then((s) => !cancelled && setHasToken(!!s.openaiToken.trim()))
            .catch(() => !cancelled && setHasToken(null));
        return () => {
            cancelled = true;
        };
    }, []);

    // Tear down any live listeners when the tab unmounts.
    useEffect(() => {
        return () => {
            unlistenRef.current.forEach((fn) => fn());
            unlistenRef.current = [];
        };
    }, []);

    // Keep the thread pinned to the latest content as it streams.
    useEffect(() => {
        const el = threadRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages]);

    function patchMessage(id: string, patch: (m: ChatMessage) => ChatMessage) {
        setMessages((prev) =>
            prev.map((m) => (m.id === id ? patch(m) : m)),
        );
    }

    function teardownListeners() {
        unlistenRef.current.forEach((fn) => fn());
        unlistenRef.current = [];
    }

    async function send() {
        const prompt = input.trim();
        if (!prompt || busy || hasToken === false) return;

        setError(null);
        setBusy(true);

        const genId = newId();
        const assistantId = newId();
        genIdRef.current = genId;

        // History is the prior conversation as plain text turns; tool rounds
        // stay internal to each generation (a v1 simplification).
        const history = messages
            .filter((m) => m.text.trim())
            .map((m) => ({ role: m.role, text: m.text }));

        const userMsg: ChatMessage = {
            id: newId(),
            role: "user",
            text: prompt,
            tools: [],
            status: "done",
        };
        const assistantMsg: ChatMessage = {
            id: assistantId,
            role: "assistant",
            text: "",
            tools: [],
            status: "streaming",
        };
        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        setInput("");

        let toolKey = 0;

        // --- Attach listeners BEFORE invoking, so no early event is dropped ---
        const unOut = await api.onAiOutput((e) => {
            if (e.genId !== genId) return;
            patchMessage(assistantId, (m) => ({ ...m, text: m.text + e.delta }));
        });
        const unTool = await api.onAiTool((e) => {
            if (e.genId !== genId) return;
            patchMessage(assistantId, (m) => {
                if (e.phase === "running") {
                    return {
                        ...m,
                        tools: [
                            ...m.tools,
                            {
                                key: toolKey++,
                                tool: e.tool,
                                summary: e.summary,
                                phase: "running",
                            },
                        ],
                    };
                }
                // Resolve the most recent still-running entry for this tool.
                const tools = [...m.tools];
                for (let i = tools.length - 1; i >= 0; i--) {
                    if (
                        tools[i].tool === e.tool &&
                        tools[i].phase === "running"
                    ) {
                        tools[i] = {
                            ...tools[i],
                            summary: e.summary,
                            phase: e.phase,
                        };
                        return { ...m, tools };
                    }
                }
                return {
                    ...m,
                    tools: [
                        ...m.tools,
                        {
                            key: toolKey++,
                            tool: e.tool,
                            summary: e.summary,
                            phase: e.phase,
                        },
                    ],
                };
            });
        });
        const unFin = await api.onAiFinished((e) => {
            if (e.genId !== genId) return;
            if (e.status === "success") {
                patchMessage(assistantId, (m) => ({ ...m, status: "done" }));
                onGenerated();
            } else if (e.status === "cancelled") {
                patchMessage(assistantId, (m) => ({ ...m, status: "cancelled" }));
                // Files may have been written before the stop — refresh Build.
                onGenerated();
            } else {
                patchMessage(assistantId, (m) => ({
                    ...m,
                    status: "error",
                    error: e.message ?? "Generation failed.",
                }));
            }
            setBusy(false);
            genIdRef.current = null;
            teardownListeners();
        });

        unlistenRef.current = [unOut, unTool, unFin];

        try {
            await api.generateTask({
                projectId: project.id,
                taskId: task.id,
                genId,
                model,
                prompt,
                history,
            });
        } catch (e) {
            // Failed to even start: surface on the assistant bubble and stop.
            patchMessage(assistantId, (m) => ({
                ...m,
                status: "error",
                error: String(e),
            }));
            setBusy(false);
            genIdRef.current = null;
            teardownListeners();
        }
    }

    // Ask the backend to cancel the current generation. The `ai-finished`
    // listener (status "cancelled") does the UI cleanup, so we just fire the
    // request here.
    function stop() {
        const genId = genIdRef.current;
        if (!genId) return;
        api.cancelGeneration(genId).catch(() => {});
    }

    function openSettings() {
        api.requestOpenSettings().catch(() => {});
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
        }
    }

    const tokenMissing = hasToken === false;

    return (
        <div className="generate-tab">
            {tokenMissing && (
                <div className="banner banner--warn">
                    Add your OpenAI token in Settings to generate tasks.{" "}
                    <button className="link-button" onClick={openSettings}>
                        Open Settings
                    </button>
                </div>
            )}
            {!hasCodebase && (
                <div className="banner banner--warn">
                    No codebase path is configured for this project, so the
                    agent can't read the codebase. It can still write task files
                    from your description. Set a codebase path in Configure to
                    let it inspect your project.
                </div>
            )}
            {error && <div className="banner banner--error">{error}</div>}

            <div className="chat-thread" ref={threadRef}>
                {messages.length === 0 ? (
                    <div className="chat-empty">
                        <SparklesIcon className="chat-empty-icon" />
                        <p>
                            Describe what you want this task to do. The agent
                            reads your codebase and writes the task's files
                            (including <code>main.sh</code>).
                        </p>
                    </div>
                ) : (
                    messages.map((m) => (
                        <div
                            key={m.id}
                            className={"chat-msg chat-msg--" + m.role}
                        >
                            <div className="chat-msg-role">
                                {m.role === "user" ? "You" : "Agent"}
                            </div>
                            {m.tools.length > 0 && (
                                <ul className="chat-tools">
                                    {m.tools.map((t) => (
                                        <li
                                            key={t.key}
                                            className={
                                                "chat-tool chat-tool--" +
                                                t.phase
                                            }
                                        >
                                            <span className="chat-tool-dot" />
                                            {t.summary}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {m.text && (
                                <div className="chat-msg-text">{m.text}</div>
                            )}
                            {m.status === "streaming" && !m.text && (
                                <div className="chat-msg-text chat-msg-text--pending muted">
                                    Thinking…
                                </div>
                            )}
                            {m.status === "cancelled" && (
                                <div className="chat-msg-text muted">
                                    Stopped.
                                </div>
                            )}
                            {m.status === "error" && (
                                <div className="chat-msg-error">
                                    {m.error ?? "Generation failed."}
                                    {isTokenError(m.error) && (
                                        <>
                                            {" "}
                                            <button
                                                className="link-button"
                                                onClick={openSettings}
                                            >
                                                Open Settings
                                            </button>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>

            <div className="chat-composer">
                <textarea
                    className="chat-input"
                    value={input}
                    placeholder="Describe what you want the task to do"
                    rows={3}
                    disabled={busy || tokenMissing}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                />
                <div className="chat-composer-foot">
                    <select
                        className="container-select"
                        value={model}
                        disabled={busy}
                        onChange={(e) => setModel(e.target.value)}
                        aria-label="Model"
                    >
                        {AI_MODELS.map((mdl) => (
                            <option key={mdl.id} value={mdl.id}>
                                {mdl.label}
                            </option>
                        ))}
                    </select>
                    {busy ? (
                        <button
                            className="ghost-button ghost-button--danger"
                            onClick={stop}
                        >
                            <StopIcon className="ic" />
                            Stop
                        </button>
                    ) : (
                        <button
                            className="primary-button"
                            onClick={() => void send()}
                            disabled={!input.trim() || tokenMissing}
                        >
                            <PaperAirplaneIcon className="ic" />
                            Send
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

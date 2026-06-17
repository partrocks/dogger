import { useEffect, useRef, useState } from "react";
import {
    ArrowPathIcon,
    MicrophoneIcon,
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

    // Dictation: capture audio in the webview, transcribe it in Rust (keeping
    // the OpenAI token off the frontend), then append the text to the input.
    const [recording, setRecording] = useState(false);
    const [transcribing, setTranscribing] = useState(false);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const audioStreamRef = useRef<MediaStream | null>(null);

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

    // Tear down any live listeners — and stop a dangling mic stream — when the
    // tab unmounts mid-recording.
    useEffect(() => {
        return () => {
            unlistenRef.current.forEach((fn) => fn());
            unlistenRef.current = [];
            const recorder = recorderRef.current;
            if (recorder && recorder.state !== "inactive") recorder.stop();
            audioStreamRef.current?.getTracks().forEach((t) => t.stop());
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

    // ---- Dictation ---------------------------------------------------------

    // Pick a recording container the webview actually supports. WebKit (macOS)
    // records `audio/mp4`; Chromium-based webviews record `audio/webm`. We let
    // the recorder choose its default when none of these is advertised.
    function pickAudioMimeType(): string | undefined {
        if (typeof MediaRecorder === "undefined") return undefined;
        const candidates = ["audio/webm", "audio/mp4", "audio/ogg"];
        return candidates.find((t) => MediaRecorder.isTypeSupported(t));
    }

    // Strip the `data:<mime>;base64,` prefix that `readAsDataURL` adds, leaving
    // just the base64 payload the backend expects.
    function blobToBase64(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () =>
                reject(reader.error ?? new Error("could not read the recording"));
            reader.onloadend = () => {
                const result = String(reader.result ?? "");
                const comma = result.indexOf(",");
                resolve(comma >= 0 ? result.slice(comma + 1) : result);
            };
            reader.readAsDataURL(blob);
        });
    }

    async function startRecording() {
        if (recording || transcribing || busy || tokenMissing) return;
        setError(null);
        if (!navigator.mediaDevices?.getUserMedia) {
            setError("Microphone recording isn't available in this environment.");
            return;
        }
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            setError(
                "Couldn't access the microphone. Grant Dogger microphone access in System Settings → Privacy & Security → Microphone.",
            );
            return;
        }
        audioStreamRef.current = stream;
        audioChunksRef.current = [];
        const mimeType = pickAudioMimeType();
        const recorder = new MediaRecorder(
            stream,
            mimeType ? { mimeType } : undefined,
        );
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunksRef.current.push(e.data);
        };
        recorder.onstop = () => void finishRecording();
        recorder.start();
        setRecording(true);
    }

    function stopRecording() {
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== "inactive") recorder.stop();
        setRecording(false);
    }

    // Invoked once the recorder has flushed its final chunk: assemble the clip,
    // hand it to the backend for transcription, and append the result.
    async function finishRecording() {
        audioStreamRef.current?.getTracks().forEach((t) => t.stop());
        audioStreamRef.current = null;
        const recorder = recorderRef.current;
        recorderRef.current = null;
        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];
        if (chunks.length === 0) return;

        const mimeType = recorder?.mimeType || chunks[0]?.type || "audio/webm";
        const blob = new Blob(chunks, { type: mimeType });

        setTranscribing(true);
        try {
            const audioBase64 = await blobToBase64(blob);
            const text = (
                await api.transcribeAudio({ audioBase64, mimeType })
            ).trim();
            if (text) {
                setInput((prev) =>
                    prev.trim() ? `${prev.trimEnd()} ${text}` : text,
                );
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setTranscribing(false);
        }
    }

    function toggleRecording() {
        if (recording) stopRecording();
        else void startRecording();
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
                    <div className="chat-composer-tools">
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
                        <button
                            type="button"
                            className={
                                "ghost-button chat-mic" +
                                (recording ? " chat-mic--recording" : "")
                            }
                            onClick={toggleRecording}
                            disabled={busy || tokenMissing || transcribing}
                            aria-pressed={recording}
                            aria-label={
                                recording ? "Stop dictation" : "Dictate"
                            }
                            title={
                                tokenMissing
                                    ? "Add your OpenAI token in Settings to dictate"
                                    : recording
                                      ? "Stop dictation"
                                      : "Dictate your message"
                            }
                        >
                            {transcribing ? (
                                <ArrowPathIcon className="ic chat-mic-spin" />
                            ) : (
                                <MicrophoneIcon className="ic" />
                            )}
                            {transcribing
                                ? "Transcribing…"
                                : recording
                                  ? "Recording…"
                                  : "Dictate"}
                        </button>
                    </div>
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

import { WebSocketServer, WebSocket } from "ws";

type JsonObject = Record<string, any>;
type EventHandler = (body: any) => Promise<void>;
type PendingWaiter = {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
    timeoutMs: number;
    action: string;
    streamChunks: any[];
};

const WS_TRANSPORTS = new Set(["ws-client", "ws-server"]);

function normalizeTransport(raw: any): string {
    return String(raw || "http").trim().toLowerCase();
}

function normalizeToken(config: any): string {
    return String(config?.wsToken || config?.token || config?.accessToken || "").trim();
}

function withAccessToken(rawUrl: string, token: string): string {
    if (!token) return rawUrl;
    try {
        const u = new URL(rawUrl);
        if (!u.searchParams.has("access_token")) u.searchParams.set("access_token", token);
        return u.toString();
    } catch {
        return rawUrl;
    }
}

function normalizeWsClientUrl(config: any): string {
    const direct = String(config?.wsUrl || "").trim();
    if (direct) return direct;
    const host = String(config?.wsHost || "127.0.0.1").trim();
    const port = Number(config?.wsPort || 3001);
    const path = String(config?.wsPath || "/").trim();
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `ws://${host}:${port}${normalizedPath}`;
}

function normalizeWsServerPath(config: any): string {
    const path = String(config?.wsPath || "/").trim();
    return path.startsWith("/") ? path : `/${path}`;
}

function nowMs() {
    return Date.now();
}

class NapCatWsRuntime {
    private mode: "none" | "ws-client" | "ws-server" = "none";
    private eventHandler: EventHandler | null = null;
    private clientSocket: WebSocket | null = null;
    private clientReconnectTimer: NodeJS.Timeout | null = null;
    private clientHeartbeatTimer: NodeJS.Timeout | null = null;
    private wsServer: WebSocketServer | null = null;
    private serverSockets: Set<WebSocket> = new Set();
    private serverHeartbeatTimer: NodeJS.Timeout | null = null;
    private pending = new Map<string, PendingWaiter>();
    private seq = 0;
    private currentConfig: any = {};

    setEventHandler(handler: EventHandler) {
        this.eventHandler = handler;
    }

    async start(config: any) {
        this.currentConfig = config || {};
        const transport = normalizeTransport(config?.transport);
        if (!WS_TRANSPORTS.has(transport)) {
            await this.stop();
            return;
        }

        if (transport === "ws-client") {
            if (this.mode !== "ws-client") await this.stop();
            this.mode = "ws-client";
            this.ensureClientConnected();
            this.ensureClientHeartbeat();
            return;
        }

        if (transport === "ws-server") {
            if (this.mode !== "ws-server") await this.stop();
            this.mode = "ws-server";
            this.ensureServerStarted();
            this.ensureServerHeartbeat();
        }
    }

    async stop() {
        this.mode = "none";
        this.clearAllPending(new Error("NapCat WS transport stopped"));

        if (this.clientReconnectTimer) clearTimeout(this.clientReconnectTimer);
        this.clientReconnectTimer = null;
        if (this.clientHeartbeatTimer) clearInterval(this.clientHeartbeatTimer);
        this.clientHeartbeatTimer = null;
        if (this.clientSocket) {
            try { this.clientSocket.close(); } catch {}
        }
        this.clientSocket = null;

        if (this.serverHeartbeatTimer) clearInterval(this.serverHeartbeatTimer);
        this.serverHeartbeatTimer = null;
        for (const socket of this.serverSockets) {
            try { socket.close(); } catch {}
        }
        this.serverSockets.clear();
        if (this.wsServer) {
            await new Promise<void>((resolve) => {
                this.wsServer?.close(() => resolve());
            });
        }
        this.wsServer = null;
    }

    private ensureClientConnected() {
        if (this.clientSocket && this.clientSocket.readyState === WebSocket.OPEN) return;
        if (this.clientSocket && this.clientSocket.readyState === WebSocket.CONNECTING) return;

        const token = normalizeToken(this.currentConfig);
        const rawUrl = normalizeWsClientUrl(this.currentConfig);
        const wsUrl = withAccessToken(rawUrl, token);
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

        console.log(`[NapCat][WS] connecting as client: ${wsUrl}`);
        const socket = new WebSocket(wsUrl, headers ? { headers } : undefined);
        this.clientSocket = socket;

        socket.on("open", () => {
            console.log("[NapCat][WS] client connected");
        });

        socket.on("message", (raw) => {
            this.onMessage(raw.toString("utf8"));
        });

        socket.on("error", (err) => {
            console.error("[NapCat][WS] client error:", err);
        });

        socket.on("close", () => {
            console.warn("[NapCat][WS] client disconnected");
            if (this.mode !== "ws-client") return;
            const reconnectMs = Math.max(1000, Number(this.currentConfig?.wsReconnectMs || 30000));
            if (this.clientReconnectTimer) clearTimeout(this.clientReconnectTimer);
            this.clientReconnectTimer = setTimeout(() => this.ensureClientConnected(), reconnectMs);
        });
    }

    private ensureClientHeartbeat() {
        if (this.clientHeartbeatTimer) clearInterval(this.clientHeartbeatTimer);
        const interval = Math.max(5000, Number(this.currentConfig?.wsHeartbeatMs || 30000));
        this.clientHeartbeatTimer = setInterval(() => {
            if (!this.clientSocket || this.clientSocket.readyState !== WebSocket.OPEN) return;
            try {
                this.clientSocket.ping();
            } catch (err) {
                console.warn("[NapCat][WS] client heartbeat failed:", err);
            }
        }, interval);
    }

    private ensureServerStarted() {
        if (this.wsServer) return;
        const host = String(this.currentConfig?.wsHost || "0.0.0.0").trim();
        const port = Number(this.currentConfig?.wsPort || 3001);
        const path = normalizeWsServerPath(this.currentConfig);
        const token = normalizeToken(this.currentConfig);

        const server = new WebSocketServer({ host, port, path });
        this.wsServer = server;
        console.log(`[NapCat][WS] server listening on ws://${host}:${port}${path}`);

        server.on("connection", (socket, req) => {
            try {
                if (token) {
                    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
                    const qToken = String(reqUrl.searchParams.get("access_token") || "").trim();
                    const auth = String(req.headers.authorization || "").trim();
                    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
                    if (qToken !== token && bearer !== token) {
                        socket.close(1008, "unauthorized");
                        return;
                    }
                }
            } catch {
                socket.close(1008, "unauthorized");
                return;
            }

            this.serverSockets.add(socket);
            socket.on("message", (raw) => this.onMessage(raw.toString("utf8")));
            socket.on("close", () => this.serverSockets.delete(socket));
            socket.on("error", (err) => console.error("[NapCat][WS] server socket error:", err));
        });

        server.on("error", (err) => {
            console.error("[NapCat][WS] server error:", err);
        });
    }

    private ensureServerHeartbeat() {
        if (this.serverHeartbeatTimer) clearInterval(this.serverHeartbeatTimer);
        const interval = Math.max(5000, Number(this.currentConfig?.wsHeartbeatMs || 30000));
        this.serverHeartbeatTimer = setInterval(() => {
            for (const socket of this.serverSockets) {
                if (socket.readyState !== WebSocket.OPEN) continue;
                try {
                    socket.ping();
                } catch {}
            }
        }, interval);
    }

    private armPendingTimer(echo: string, waiter: PendingWaiter) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.timer = setTimeout(() => {
            this.pending.delete(echo);
            waiter.reject(new Error(`NapCat WS action timeout: ${waiter.action}`));
        }, waiter.timeoutMs);
    }

    private async onMessage(raw: string) {
        let payload: any;
        try {
            payload = JSON.parse(raw);
        } catch {
            return;
        }

        if (payload && typeof payload === "object" && payload.echo) {
            const key = String(payload.echo);
            const waiter = this.pending.get(key);
            if (waiter) {
                const isStreamAction = payload.stream === "stream-action";
                const streamType = String(payload?.data?.type || "").trim().toLowerCase();
                if (isStreamAction && streamType === "stream") {
                    waiter.streamChunks.push(payload.data);
                    this.armPendingTimer(key, waiter);
                    return;
                }

                clearTimeout(waiter.timer);
                this.pending.delete(key);
                if (payload.status === "failed" || streamType === "error") {
                    waiter.reject(new Error(payload?.message || `NapCat WS action failed: ${payload.retcode ?? "unknown"}`));
                } else {
                    const resultPayload = waiter.streamChunks.length
                        ? { ...payload, stream_chunks: waiter.streamChunks, stream_chunk_count: waiter.streamChunks.length }
                        : payload;
                    waiter.resolve(resultPayload);
                }
                return;
            }
        }

        if (!this.eventHandler) return;
        try {
            await this.eventHandler(payload);
        } catch (err) {
            console.error("[NapCat][WS] event handler error:", err);
        }
    }

    private pickSocketForSend(): WebSocket {
        if (this.mode === "ws-client") {
            if (this.clientSocket && this.clientSocket.readyState === WebSocket.OPEN) return this.clientSocket;
            throw new Error("NapCat WS client is not connected");
        }
        if (this.mode === "ws-server") {
            for (const socket of this.serverSockets) {
                if (socket.readyState === WebSocket.OPEN) return socket;
            }
            throw new Error("NapCat WS server has no connected client");
        }
        throw new Error("NapCat WS transport is not active");
    }

    private clearAllPending(err: Error) {
        for (const [, waiter] of this.pending) {
            clearTimeout(waiter.timer);
            waiter.reject(err);
        }
        this.pending.clear();
    }

    async sendAction(action: string, params: JsonObject, timeoutMs?: number): Promise<any> {
        const socket = this.pickSocketForSend();
        const echo = `openclaw-${action}-${nowMs()}-${++this.seq}`;
        const message = JSON.stringify({ action, params, echo });
        const waitMs = Math.max(1000, Number(timeoutMs || this.currentConfig?.wsRequestTimeoutMs || 10000));

        return new Promise((resolve, reject) => {
            const waiter: PendingWaiter = {
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.pending.delete(echo);
                    reject(new Error(`NapCat WS action timeout: ${action}`));
                }, waitMs),
                timeoutMs: waitMs,
                action,
                streamChunks: [],
            };
            this.pending.set(echo, waiter);
            try {
                socket.send(message);
            } catch (err: any) {
                clearTimeout(waiter.timer);
                this.pending.delete(echo);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
}

const runtime = new NapCatWsRuntime();

export function isWsTransport(config: any): boolean {
    return WS_TRANSPORTS.has(normalizeTransport(config?.transport));
}

export async function startNapCatWs(config: any, eventHandler: EventHandler): Promise<void> {
    runtime.setEventHandler(eventHandler);
    await runtime.start(config);
}

export async function stopNapCatWs(): Promise<void> {
    await runtime.stop();
}

export async function sendNapCatActionOverWs(action: string, params: JsonObject, timeoutMs?: number): Promise<any> {
    return runtime.sendAction(action, params, timeoutMs);
}


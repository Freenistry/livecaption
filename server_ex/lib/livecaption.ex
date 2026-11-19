# HTTP + WebSocket server for the app page (public/app.html). Elixir owns connections; the models run in one Node
# child process (engine.js), because sherpa-onnx and Bergamot only ship Node bindings. Each browser WebSocket is a
# session id multiplexed over the child's stdin/stdout. If the child crashes, the supervisor restarts it and the
# open sockets close (the page shows "idle"; press Start again).
#
#   GET /                -> public/app.html (also /live.html, other files under public/)
#   GET /api/languages   -> spoken languages + targets and whether their models are installed
#   GET /api/health      -> {"ok":true}
#   WS  /live?lang=en&to=zh-Hans,es   (80 ms PCM16 frames in, JSON captions out; same protocol as server.js)
#
# Env: PORT (3000), HOST (127.0.0.1), APP_ROOT (dir with engine.js + public/), MT_URL (http://127.0.0.1:8099), APP_TOKEN (empty = open, fine for localhost), NODE (node),
#      PID_FILE (written on boot; serve.sh stops the VM with it, which closes engine.js's stdin so Node exits too).

defmodule Livecaption do
  @moduledoc "Where engine.js and public/ live: APP_ROOT (set in Docker / releases), else the repo this was compiled in."
  @src Path.expand("../..", __DIR__)
  def root, do: System.get_env("APP_ROOT", @src)
  def public, do: Path.join(root(), "public")
end

defmodule Livecaption.Application do
  use Application

  def start(_type, _args) do
    port = String.to_integer(System.get_env("PORT", "3000"))
    {:ok, ip} = :inet.parse_address(String.to_charlist(System.get_env("HOST", "127.0.0.1"))) # 0.0.0.0 in Docker
    children = [Livecaption.Engine, {Bandit, plug: Livecaption.Router, port: port, ip: ip}]
    {:ok, pid} = Supervisor.start_link(children, strategy: :one_for_one, name: Livecaption.Supervisor)
    if f = System.get_env("PID_FILE"), do: File.write!(f, System.pid()) # the VM itself, not the mix/elixir wrapper scripts
    IO.puts("http://localhost:#{port}")
    {:ok, pid}
  end
end

defmodule Livecaption.Engine do
  @moduledoc "Owns the Node child (engine.js) and routes its frames to the right WebSocket process."
  use GenServer

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)
  def open(params), do: GenServer.call(__MODULE__, {:open, self(), params})
  def audio(sid, pcm), do: GenServer.cast(__MODULE__, {:send, 2, sid, pcm})
  def flush(sid), do: GenServer.cast(__MODULE__, {:send, 3, sid, ""})
  def close(sid), do: GenServer.cast(__MODULE__, {:send, 4, sid, ""})
  def languages, do: GenServer.call(__MODULE__, :languages)

  @impl true
  def init(_) do
    node = System.find_executable(System.get_env("NODE", "node")) || raise "node not found on PATH"
    port = Port.open({:spawn_executable, node}, [:binary, {:packet, 4}, :exit_status, args: [Path.join(Livecaption.root(), "engine.js")], cd: Livecaption.root()])
    {:ok, %{port: port, next: 1, sessions: %{}, languages: nil}}
  end

  @impl true
  def handle_call({:open, pid, params}, _from, s) do
    sid = s.next
    Process.monitor(pid)
    send_frame(s.port, 1, sid, JSON.encode!(params))
    {:reply, sid, %{s | next: sid + 1, sessions: Map.put(s.sessions, sid, pid)}}
  end

  def handle_call(:languages, _from, s), do: {:reply, s.languages, s}

  @impl true
  def handle_cast({:send, kind, sid, data}, s) do
    if Map.has_key?(s.sessions, sid), do: send_frame(s.port, kind, sid, data)
    {:noreply, if(kind == 4, do: %{s | sessions: Map.delete(s.sessions, sid)}, else: s)}
  end

  @impl true
  def handle_info({port, {:data, <<kind, sid::32, payload::binary>>}}, %{port: port} = s) do
    case kind do
      1 -> (pid = s.sessions[sid]) && send(pid, {:engine, payload}); {:noreply, s}
      2 -> (pid = s.sessions[sid]) && send(pid, :engine_closed); {:noreply, %{s | sessions: Map.delete(s.sessions, sid)}}
      3 -> {:noreply, %{s | languages: payload}}
    end
  end

  def handle_info({port, {:exit_status, code}}, %{port: port} = s), do: {:stop, {:engine_exited, code}, s}

  def handle_info({:DOWN, _, :process, pid, _}, s) do # browser gone without a clean close
    case Enum.find(s.sessions, fn {_, p} -> p == pid end) do
      {sid, _} -> send_frame(s.port, 4, sid, ""); {:noreply, %{s | sessions: Map.delete(s.sessions, sid)}}
      nil -> {:noreply, s}
    end
  end

  defp send_frame(port, kind, sid, data), do: Port.command(port, [<<kind, sid::32>>, data])
end

defmodule Livecaption.Socket do
  @moduledoc "One browser WebSocket = one engine session."
  @behaviour WebSock
  @max_frame 64 * 1024 # the page sends 80 ms = 2560 bytes

  @impl true
  def init(params), do: {:ok, %{sid: Livecaption.Engine.open(params)}}

  @impl true
  def handle_in({pcm, opcode: :binary}, s) when byte_size(pcm) <= @max_frame and rem(byte_size(pcm), 2) == 0 do
    Livecaption.Engine.audio(s.sid, pcm)
    {:ok, s}
  end

  def handle_in({"flush", opcode: :text}, s), do: (Livecaption.Engine.flush(s.sid); {:ok, s})
  def handle_in(_, s), do: {:ok, s}

  @impl true
  def handle_info({:engine, json}, s), do: {:push, {:text, json}, s}
  def handle_info(:engine_closed, s), do: {:stop, :normal, s}
  def handle_info(_, s), do: {:ok, s}

  @impl true
  def terminate(_, s), do: Livecaption.Engine.close(s.sid)
end

defmodule Livecaption.Router do
  use Plug.Router
  plug Plug.Static, at: "/", from: {Livecaption, :public, []}, only: ~w(app.html live.html index.html vad.js)
  plug :match
  plug :dispatch

  get "/", do: conn |> put_resp_content_type("text/html") |> send_file(200, Path.join(Livecaption.public(), "app.html"))
  get "/api/health", do: json(conn, ~s({"ok":true,"backend":"elixir"}))

  get "/api/languages" do
    case Livecaption.Engine.languages() do
      nil -> json(conn, ~s({"error":"engine starting"}), 503)
      langs -> json(conn, langs)
    end
  end

  get "/live" do
    conn = fetch_query_params(conn)
    token = System.get_env("APP_TOKEN", "")
    if token != "" and not Plug.Crypto.secure_compare(conn.params["token"] || "", token) do
      send_resp(conn, 401, "unauthorized")
    else
      params = %{lang: conn.params["lang"] || "en", to: conn.params["to"] || "zh-Hans"}
      conn |> WebSockAdapter.upgrade(Livecaption.Socket, params, timeout: 120_000) |> halt()
    end
  end

  match _, do: send_resp(conn, 404, "not found")

  defp json(conn, body, status \\ 200), do: conn |> put_resp_content_type("application/json") |> send_resp(status, body)
end

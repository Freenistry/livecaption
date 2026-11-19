# HTTP + WebSocket server for the app page (public/app.html). Elixir owns connections; the models run in one Node
# child process (engine.js), because sherpa-onnx and Bergamot only ship Node bindings. Each browser WebSocket is a
# session id multiplexed over the child's stdin/stdout. If the child crashes, the supervisor restarts it and the
# open sockets close (the page shows "idle"; press Start again).
#
#   GET /                -> public/app.html (also /live.html, other files under public/)
#   GET /api/languages   -> spoken languages + targets and whether their models are installed
#   GET /api/health      -> {"ok":true}
#   WS  /live?lang=en&to=zh-Hans,es[&tag=x][&room=r]   (80 ms PCM16 frames in, JSON captions out; same protocol as server.js)
#   Rooms (1 speaker -> many listeners): the speaker adds &room=r; listeners open /r/<room> (public/watch.html), which
#   connects to WS /listen?room=r&to=es and receives that language's tr_partial/final messages. Translation runs once
#   per language, not per listener. GET /api/rooms/<room> -> {"live":true,"to":[...]}; GET /api/stats -> listeners, memory.
#
# Env: PORT (3000), HOST (127.0.0.1), APP_ROOT (dir with engine.js + public/), MT_URL (http://127.0.0.1:8099), APP_TOKEN (empty = open, fine for localhost), EVAL_LOG (file or - : one JSON line per endpoint/final, see eval-live.js), MAX_LISTENERS (5000), NODE (node),
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
    children = [{Registry, keys: :unique, name: Livecaption.Speakers}, {Registry, keys: :duplicate, name: Livecaption.Rooms, partitions: System.schedulers_online()},
                Livecaption.Engine, {Bandit, plug: Livecaption.Router, port: port, ip: ip}]
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
  def open(params), do: GenServer.call(__MODULE__, {:open, self(), params}, 15_000)
  def audio(sid, pcm), do: GenServer.cast(__MODULE__, {:send, 2, sid, pcm})
  def flush(sid), do: GenServer.cast(__MODULE__, {:send, 3, sid, ""})
  def close(sid), do: GenServer.cast(__MODULE__, {:send, 4, sid, ""})
  def languages, do: GenServer.call(__MODULE__, :languages)

  @impl true
  def init(_) do
    node = System.find_executable(System.get_env("NODE", "node")) || raise "node not found on PATH"
    # busy_limits_port off: by default the port blocks this GenServer once ~8 KB (250 ms of audio) is queued, so a busy
    # Node (loading 10 Bergamot models) froze every session and timed out calls. The queue now grows in memory instead.
    port = Port.open({:spawn_executable, node}, [:binary, {:packet, 4}, :exit_status, {:busy_limits_port, :disabled}, args: [Path.join(Livecaption.root(), "engine.js")], cd: Livecaption.root()])
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

defmodule Livecaption.Rooms do
  @moduledoc "Fan-out: Livecaption.Speakers maps room -> speaker pid (value: its languages); this registry maps {room, lang} -> listener pids."
  def publish(room, json) do # one engine message from the speaker's session -> every listener of that language
    case JSON.decode(json) do
      {:ok, %{"type" => t, "to" => to}} when t in ["tr_partial", "final"] -> send_to(room, to, json)
      _ -> :ok
    end
  end
  def status(room, langs, live), do: for(l <- langs, do: send_to(room, l, JSON.encode!(%{type: "status", level: "info", live: live, msg: if(live, do: "live", else: "the speaker stopped")})))
  defp send_to(room, lang, json), do: Registry.dispatch(__MODULE__, {room, lang}, fn ls -> for {pid, _} <- ls, do: send(pid, {:caption, json}) end)
end

defmodule Livecaption.Listen do
  @moduledoc "One listener WebSocket: receives one language of one room, sends nothing but keep-alive pings."
  @behaviour WebSock
  @impl true
  def init({room, to}) do
    Registry.register(Livecaption.Rooms, {room, to}, nil)
    live = Registry.lookup(Livecaption.Speakers, room) != []
    {:push, {:text, JSON.encode!(%{type: "status", level: "info", live: live, msg: if(live, do: "live", else: "waiting for the speaker")})}, %{}}
  end
  @impl true
  def handle_in(_, s), do: {:ok, s} # "ping" every 30 s keeps proxies and the idle timeout from closing the socket
  @impl true
  def handle_info({:caption, json}, s), do: {:push, {:text, json}, s}
  def handle_info(_, s), do: {:ok, s}
end

defmodule Livecaption.Socket do
  @moduledoc "One browser WebSocket = one engine session (+ optional room fan-out)."
  @behaviour WebSock
  @max_frame 64 * 1024 # the page sends 80 ms = 2560 bytes

  @impl true
  def init(params) do
    langs = String.split(params.to, ",")
    if r = params.room do
      {:ok, _} = Registry.register(Livecaption.Speakers, r, langs) # a race with a second speaker crashes this socket: fine
      Livecaption.Rooms.status(r, langs, true)
    end
    {:ok, %{sid: Livecaption.Engine.open(params), room: params.room, langs: langs}}
  end

  @impl true
  def handle_in({pcm, opcode: :binary}, s) when byte_size(pcm) <= @max_frame and rem(byte_size(pcm), 2) == 0 do
    Livecaption.Engine.audio(s.sid, pcm)
    {:ok, s}
  end

  def handle_in({"flush", opcode: :text}, s), do: (Livecaption.Engine.flush(s.sid); {:ok, s})
  def handle_in(_, s), do: {:ok, s}

  @impl true
  def handle_info({:engine, json}, s) do
    if s.room, do: Livecaption.Rooms.publish(s.room, json)
    {:push, {:text, json}, s}
  end
  def handle_info(:engine_closed, s), do: {:stop, :normal, s}
  def handle_info(_, s), do: {:ok, s}

  @impl true
  def terminate(_, s) do
    if s.room, do: Livecaption.Rooms.status(s.room, s.langs, false)
    Livecaption.Engine.close(s.sid)
  end
end

defmodule Livecaption.Router do
  use Plug.Router
  @room ~r/^[a-z0-9-]{1,32}$/
  plug Plug.Static, at: "/", from: {Livecaption, :public, []}, only: ~w(app.html live.html watch.html index.html vad.js)
  plug :match
  plug :dispatch

  get "/", do: conn |> put_resp_content_type("text/html") |> send_file(200, Path.join(Livecaption.public(), "app.html"))
  get "/r/:room", do: conn |> put_resp_content_type("text/html") |> send_file(200, Path.join(Livecaption.public(), "watch.html"))

  get "/api/rooms/:room" do
    case Registry.lookup(Livecaption.Speakers, room) do
      [{_, to}] -> json(conn, JSON.encode!(%{live: true, to: to}))
      [] -> json(conn, ~s({"live":false}))
    end
  end

  get "/api/stats" do
    conn = fetch_query_params(conn)
    if authed?(conn),
      do: json(conn, JSON.encode!(%{listeners: Registry.count(Livecaption.Rooms), speakers: Registry.count(Livecaption.Speakers),
        memoryMB: div(:erlang.memory(:total), 1_048_576), processes: :erlang.system_info(:process_count)})),
      else: send_resp(conn, 401, "unauthorized")
  end

  # Public on purpose: listeners from the internet need no token, only the room name. Read-only, capped by MAX_LISTENERS.
  get "/listen" do
    conn = fetch_query_params(conn)
    {room, to} = {conn.params["room"] || "", conn.params["to"] || ""}
    cond do
      not Regex.match?(@room, room) or not Regex.match?(~r/^[A-Za-z-]{2,10}$/, to) -> send_resp(conn, 400, "need room=[a-z0-9-]{1,32} and to=<language>")
      Registry.count(Livecaption.Rooms) >= String.to_integer(System.get_env("MAX_LISTENERS", "5000")) -> send_resp(conn, 503, "full")
      true -> conn |> WebSockAdapter.upgrade(Livecaption.Listen, {room, to}, timeout: 90_000, max_frame_size: 1024) |> halt()
    end
  end

  get "/api/health", do: json(conn, ~s({"ok":true,"backend":"elixir"}))

  get "/api/languages" do
    case Livecaption.Engine.languages() do
      nil -> json(conn, ~s({"error":"engine starting"}), 503)
      langs -> json(conn, langs)
    end
  end

  get "/live" do
    conn = fetch_query_params(conn)
    room = conn.params["room"]
    cond do
      not authed?(conn) -> send_resp(conn, 401, "unauthorized")
      room && not Regex.match?(@room, room) -> send_resp(conn, 400, "room: 1-32 of a-z 0-9 -")
      room && Registry.lookup(Livecaption.Speakers, room) != [] -> send_resp(conn, 409, "room already has a speaker")
      true ->
        params = %{lang: conn.params["lang"] || "en", to: conn.params["to"] || "zh-Hans", tag: conn.params["tag"] || "", room: room}
        conn |> WebSockAdapter.upgrade(Livecaption.Socket, params, timeout: 120_000) |> halt()
    end
  end

  match _, do: send_resp(conn, 404, "not found")

  defp authed?(conn) do
    token = System.get_env("APP_TOKEN", "")
    token == "" or Plug.Crypto.secure_compare(conn.params["token"] || "", token)
  end

  defp json(conn, body, status \\ 200), do: conn |> put_resp_content_type("application/json") |> send_resp(status, body)
end

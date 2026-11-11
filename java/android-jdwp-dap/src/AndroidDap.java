import com.sun.jdi.*;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Attach-only DAP/JDI spike. Never invokes methods, redefines classes or exits the target. */
public final class AndroidDap {
    private final BufferedInputStream input = new BufferedInputStream(System.in);
    private volatile VirtualMachine vm;
    private boolean configured;
    private volatile boolean closed;
    private int seq = 1, nextId = 1;
    private final Map<Integer, ThreadReference> threads = new LinkedHashMap<>();
    private final Map<Integer, StackFrame> frames = new HashMap<>();
    private final Map<Integer, Object> handles = new HashMap<>();
    private final Map<String, List<LineBreakpoint>> breakpoints = new LinkedHashMap<>();
    private final List<Path> roots = new ArrayList<>();
    private final Set<String> warned = new HashSet<>();
    private final Object state = new Object();

    private static final class LineBreakpoint {
        final int id, line;
        final String path;
        final Set<Location> installed = new HashSet<>();
        LineBreakpoint(int id, int line, String path) { this.id = id; this.line = line; this.path = path; }
        Map<String, Object> body() {
            var body = new LinkedHashMap<String, Object>();
            body.put("id", id);
            body.put("line", line);
            body.put("verified", !installed.isEmpty());
            body.put("source", Map.of("path", path));
            if (installed.isEmpty()) body.put("message", "Pending class load or no executable line");
            return body;
        }
    }

    public static void main(String[] args) throws Exception {
        var adapter = new AndroidDap();
        try { adapter.run(); }
        finally { synchronized (adapter.state) { adapter.detach(); } }
    }

    private void run() throws IOException {
        while (!closed) {
            Map<String, Object> request = read();
            if (request == null) return;
            String command = (String) request.get("command");
            synchronized (state) {
                try {
                    var args = Json.object(request.getOrDefault("arguments", Map.of()));
                    Object body = dispatch(command, args);
                    send(Map.of("type", "response", "request_seq", request.get("seq"),
                            "command", command, "success", true, "body", body));
                    if (command.equals("attach")) event("initialized", Map.of());
                    if (command.equals("disconnect")) { event("terminated", Map.of()); closed = true; }
                } catch (Exception e) {
                    System.err.println(command + ": " + e);
                    send(Map.of("type", "response", "request_seq", request.get("seq"),
                            "command", command, "success", false, "message", e.toString()));
                }
            }
        }
    }

    private Object dispatch(String command, Map<String, Object> args) throws Exception {
        if (command.equals("initialize")) {
            if (Boolean.FALSE.equals(args.get("linesStartAt1")) || Boolean.FALSE.equals(args.get("columnsStartAt1")))
                throw new IllegalArgumentException("This prototype requires 1-based DAP coordinates");
            return Map.of("supportsConfigurationDoneRequest", true, "supportsTerminateDebuggee", false,
                    "supportsVariablePaging", true);
        }
        if (command.equals("attach")) {
            if (vm != null) throw new IllegalStateException("Already attached");
            String host = (String) args.getOrDefault("hostName", "127.0.0.1");
            if (!host.equals("127.0.0.1") && !host.equals("localhost"))
                throw new IllegalArgumentException("Use a loopback adb forward");
            int port = Json.integer(args, "port");
            if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid port");
            for (Object root : Json.array(args.getOrDefault("sourceRoots", List.of())))
                roots.add(Path.of((String) root).toRealPath());
            AttachingConnector connector = Bootstrap.virtualMachineManager().attachingConnectors().stream()
                    .filter(c -> c.name().equals("com.sun.jdi.SocketAttach")).findFirst().orElseThrow();
            var options = connector.defaultArguments();
            options.get("hostname").setValue(host);
            options.get("port").setValue(Integer.toString(port));
            options.get("timeout").setValue("10000");
            vm = connector.attach(options);
            // VMStart may be resumed by the event pump; this separate hold protects setup.
            vm.suspend();
            var filters = Json.array(args.getOrDefault("classFilters", List.of("*")));
            if (filters.isEmpty()) throw new IllegalArgumentException("classFilters must not be empty");
            for (Object filter : filters) {
                var prepare = vm.eventRequestManager().createClassPrepareRequest();
                prepare.addClassFilter((String) filter);
                prepare.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                prepare.enable();
            }
            new Thread(this::pump, "jdi-events").start();
            return Map.of("vmName", vm.name(), "vmVersion", vm.version());
        }
        if (vm == null && !command.equals("disconnect")) throw new IllegalStateException("Not attached");
        return switch (command) {
            case "setBreakpoints" -> setBreakpoints(args);
            case "setExceptionBreakpoints" -> {
                if (!Json.array(args.getOrDefault("filters", List.of())).isEmpty())
                    throw new UnsupportedOperationException("Exception breakpoints are not supported");
                yield Map.of();
            }
            case "configurationDone" -> {
                if (configured) throw new IllegalStateException("Already configured");
                configured = true;
                vm.resume();
                yield Map.of();
            }
            case "threads" -> Map.of("threads", vm.allThreads().stream()
                    .map(t -> Map.of("id", threadId(t), "name", t.name())).toList());
            case "stackTrace" -> stackTrace(args);
            case "scopes" -> {
                StackFrame frame = frame(Json.integer(args, "frameId"));
                yield Map.of("scopes", List.of(Map.of("name", "Locals", "variablesReference", handle(frame),
                        "expensive", false, "presentationHint", "locals")));
            }
            case "variables" -> variables(args);
            case "continue", "next", "stepIn", "stepOut" -> {
                ThreadReference thread = thread(Json.integer(args, "threadId"));
                if (!configured || !thread.isSuspended()) throw new IllegalStateException("Target is not stopped");
                var manager = vm.eventRequestManager();
                manager.deleteEventRequests(new ArrayList<>(manager.stepRequests()));
                if (!command.equals("continue")) {
                    int depth = switch (command) {
                        case "next" -> StepRequest.STEP_OVER;
                        case "stepIn" -> StepRequest.STEP_INTO;
                        default -> StepRequest.STEP_OUT;
                    };
                    var step = manager.createStepRequest(thread, StepRequest.STEP_LINE, depth);
                    for (String filter : List.of("java.*", "javax.*", "jdk.*", "sun.*", "android.*", "kotlin.*"))
                        step.addClassExclusionFilter(filter);
                    step.addCountFilter(1);
                    step.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                    step.enable();
                }
                invalidate();
                vm.resume();
                event("continued", Map.of("threadId", threadId(thread), "allThreadsContinued", true));
                yield Map.of("allThreadsContinued", true);
            }
            case "pause" -> {
                if (!configured) throw new IllegalStateException("Configuration is not complete");
                ThreadReference thread = thread(Json.integer(args, "threadId"));
                if (thread.isSuspended()) throw new IllegalStateException("Target already stopped");
                vm.suspend();
                invalidate();
                event("stopped", Map.of("reason", "pause", "threadId", threadId(thread), "allThreadsStopped", true));
                yield Map.of();
            }
            case "disconnect" -> {
                if (Boolean.TRUE.equals(args.get("terminateDebuggee")))
                    throw new UnsupportedOperationException("Target termination is forbidden");
                detach();
                yield Map.of();
            }
            default -> throw new UnsupportedOperationException("Unsupported DAP command: " + command);
        };
    }

    private Object setBreakpoints(Map<String, Object> args) throws Exception {
        String path = Path.of((String) Json.object(args.get("source")).get("path")).toRealPath().toString();
        var list = new ArrayList<LineBreakpoint>();
        for (Object item : Json.array(args.getOrDefault("breakpoints", List.of()))) {
            var bp = Json.object(item);
            for (String unsupported : List.of("condition", "hitCondition", "logMessage"))
                if (bp.containsKey(unsupported)) throw new UnsupportedOperationException(unsupported);
            int line = Json.integer(bp, "line");
            if (line < 1) throw new IllegalArgumentException("Line must be positive");
            list.add(new LineBreakpoint(nextId++, line, path));
        }
        List<LineBreakpoint> previous = breakpoints.getOrDefault(path, List.of());
        var oldIds = previous.stream().map(b -> b.id).toList();
        var manager = vm.eventRequestManager();
        manager.deleteEventRequests(manager.breakpointRequests().stream()
                .filter(r -> oldIds.contains(r.getProperty("id"))).toList());
        breakpoints.put(path, list);
        for (ReferenceType type : vm.allClasses()) if (type.isPrepared()) install(type, false);
        return Map.of("breakpoints", list.stream().map(LineBreakpoint::body).toList());
    }

    private static String sourceSuffix(ReferenceType type, String sourceName) {
        String name = type.name();
        int dot = name.lastIndexOf('.');
        return (dot < 0 ? "" : name.substring(0, dot + 1).replace('.', '/')) + sourceName;
    }

    private boolean matches(String path, ReferenceType type, String sourceName) {
        String suffix = sourceSuffix(type, sourceName);
        String normalized = path.replace('\\', '/');
        return normalized.endsWith("/" + suffix) || normalized.equals(suffix);
    }

    private void install(ReferenceType type, boolean notify) throws AbsentInformationException {
        List<String> names;
        try { names = type.sourceNames("Java"); }
        catch (AbsentInformationException e) { return; } // Runtime classes often have no debug metadata.
        for (var list : breakpoints.values()) for (var bp : list) {
            for (String name : names) {
                if (!matches(bp.path, type, name)) continue;
                boolean wasVerified = !bp.installed.isEmpty();
                try {
                    for (Location location : type.locationsOfLine("Java", name, bp.line)) {
                        if (!bp.installed.add(location)) continue;
                        var request = vm.eventRequestManager().createBreakpointRequest(location);
                        request.putProperty("id", bp.id);
                        request.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                        request.enable();
                    }
                } catch (AbsentInformationException e) {
                    warn("No line metadata: " + type.name());
                }
                if (notify && !wasVerified && !bp.installed.isEmpty())
                    event("breakpoint", Map.of("reason", "changed", "breakpoint", bp.body()));
            }
        }
    }

    private void pump() {
        try {
            while (!closed) {
                VirtualMachine target = vm;
                if (target == null) return;
                EventSet events = target.eventQueue().remove();
                synchronized (state) {
                    if (closed || vm == null) return;
                    boolean stop = false;
                    for (Event event : events) {
                        if (event instanceof ClassPrepareEvent prepare) install(prepare.referenceType(), true);
                        if (event instanceof BreakpointEvent || event instanceof StepEvent) {
                            if (!stop) {
                                var located = (LocatableEvent) event;
                                if (event instanceof StepEvent) vm.eventRequestManager().deleteEventRequest(event.request());
                                invalidate();
                                var body = new LinkedHashMap<String, Object>();
                                body.put("reason", event instanceof StepEvent ? "step" : "breakpoint");
                                body.put("threadId", threadId(located.thread()));
                                body.put("allThreadsStopped", true);
                                if (event instanceof BreakpointEvent)
                                    body.put("hitBreakpointIds", List.of(event.request().getProperty("id")));
                                event("stopped", body);
                            }
                            stop = true;
                        }
                        if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) {
                            event("terminated", Map.of());
                            vm = null;
                            return;
                        }
                    }
                    if (!stop) events.resume();
                }
            }
        } catch (VMDisconnectedException e) {
            synchronized (state) {
                if (!closed && vm != null) { event("terminated", Map.of()); vm = null; }
            }
        } catch (Exception e) {
            synchronized (state) {
                warn("JDI event pump failed: " + e);
                detach();
                event("terminated", Map.of());
            }
        }
    }

    private Object stackTrace(Map<String, Object> args) throws Exception {
        ThreadReference thread = thread(Json.integer(args, "threadId"));
        var stack = thread.frames();
        int start = args.containsKey("startFrame") ? Json.integer(args, "startFrame") : 0;
        int levels = args.containsKey("levels") ? Json.integer(args, "levels") : 0;
        if (start < 0 || levels < 0) throw new IllegalArgumentException("Invalid frame range");
        var out = new ArrayList<Object>();
        for (int i = start; i < stack.size() && (levels == 0 || out.size() < levels); i++) {
            StackFrame frame = stack.get(i);
            int id = nextId++;
            frames.put(id, frame);
            Location location = frame.location();
            var entry = new LinkedHashMap<String, Object>();
            entry.put("id", id);
            entry.put("name", location.declaringType().name() + "." + location.method().name());
            entry.put("line", Math.max(1, location.lineNumber("Java")));
            entry.put("column", 1);
            String path = source(location);
            if (path != null) entry.put("source", Map.of("path", path, "name", Path.of(path).getFileName().toString()));
            else entry.put("presentationHint", "subtle");
            out.add(entry);
        }
        return Map.of("stackFrames", out, "totalFrames", stack.size());
    }

    private String source(Location location) throws IOException {
        String name;
        try { name = location.sourceName("Java"); }
        catch (AbsentInformationException e) { return null; }
        var candidates = new LinkedHashSet<String>();
        for (String path : breakpoints.keySet()) if (matches(path, location.declaringType(), name)) candidates.add(path);
        for (Path root : roots) {
            Path file = root.resolve(sourceSuffix(location.declaringType(), name).replace('/', File.separatorChar));
            if (Files.isRegularFile(file)) candidates.add(file.toRealPath().toString());
        }
        if (candidates.size() > 1) throw new IllegalArgumentException("Ambiguous source: " + name + " " + candidates);
        return candidates.stream().findFirst().orElse(null);
    }

    private Object variables(Map<String, Object> args) throws Exception {
        Object value = handles.get(Json.integer(args, "variablesReference"));
        if (value == null) throw new IllegalArgumentException("Stale or unknown variable reference");
        var out = new ArrayList<Object>();
        if (value instanceof StackFrame frame) {
            ObjectReference self = frame.thisObject();
            if (self != null) out.add(variable("this", self));
            for (LocalVariable local : frame.visibleVariables()) out.add(variable(local.name(), frame.getValue(local)));
        } else if (value instanceof ArrayReference array) {
            int start = args.containsKey("start") ? Json.integer(args, "start") : 0;
            int count = args.containsKey("count") ? Json.integer(args, "count") : 0;
            if (start < 0 || count < 0 || start > array.length()) throw new IllegalArgumentException("Invalid array range");
            int end = count == 0 ? array.length() : (int) Math.min(array.length(), (long) start + count);
            for (int i = start; i < end; i++) out.add(variable("[" + i + "]", array.getValue(i)));
        } else if (value instanceof ObjectReference object) {
            for (Field field : object.referenceType().allFields())
                out.add(variable(field.declaringType().name() + "." + field.name(), object.getValue(field)));
        } else throw new IllegalArgumentException("Unsupported variable handle");
        return Map.of("variables", out);
    }

    private Object variable(String name, Value value) {
        int ref = value instanceof ObjectReference && !(value instanceof StringReference) ? handle(value) : 0;
        String rendered = value == null ? "null" : value instanceof StringReference s ? Json.write(s.value()) : value.toString();
        var out = new LinkedHashMap<String, Object>();
        out.put("name", name);
        out.put("value", rendered);
        out.put("type", value == null ? "null" : value.type().name());
        out.put("variablesReference", ref);
        if (value instanceof ArrayReference array) out.put("indexedVariables", array.length());
        return out;
    }

    private int handle(Object value) { int id = nextId++; handles.put(id, value); return id; }
    private void invalidate() { frames.clear(); handles.clear(); }
    private StackFrame frame(int id) {
        StackFrame frame = frames.get(id);
        if (frame == null) throw new IllegalArgumentException("Stale or unknown frame");
        return frame;
    }
    private ThreadReference thread(int id) {
        ThreadReference thread = threads.get(id);
        if (thread == null) throw new IllegalArgumentException("Unknown thread");
        return thread;
    }
    private int threadId(ThreadReference thread) {
        for (var entry : threads.entrySet()) if (entry.getValue().equals(thread)) return entry.getKey();
        int id = nextId++;
        threads.put(id, thread);
        return id;
    }
    private void detach() {
        if (vm != null) {
            try { vm.dispose(); }
            catch (VMDisconnectedException e) { System.err.println("Target already disconnected"); }
            vm = null;
        }
        invalidate();
    }
    private void warn(String message) {
        System.err.println(message);
        if (warned.add(message)) event("output", Map.of("category", "stderr", "output", message + "\n"));
    }
    private void event(String event, Object body) { send(Map.of("type", "event", "event", event, "body", body)); }
    private synchronized void send(Map<String, Object> message) {
        var out = new LinkedHashMap<>(message);
        out.put("seq", seq++);
        byte[] bytes = Json.write(out).getBytes(StandardCharsets.UTF_8);
        try {
            System.out.write(("Content-Length: " + bytes.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            System.out.write(bytes);
            System.out.flush();
        } catch (IOException e) { throw new UncheckedIOException(e); }
    }
    private Map<String, Object> read() throws IOException {
        var header = new ByteArrayOutputStream();
        while (true) {
            int b = input.read();
            if (b < 0) {
                if (header.size() == 0) return null;
                throw new EOFException("Truncated DAP header");
            }
            header.write(b);
            if (header.size() > 8192) throw new IOException("Oversized DAP header");
            byte[] bytes = header.toByteArray();
            int n = bytes.length;
            if (n >= 4 && bytes[n - 4] == 13 && bytes[n - 3] == 10 && bytes[n - 2] == 13 && bytes[n - 1] == 10) break;
        }
        int length = -1;
        for (String line : header.toString(StandardCharsets.US_ASCII).split("\r\n")) {
            if (line.toLowerCase(Locale.ROOT).startsWith("content-length:")) {
                if (length != -1) throw new IOException("Duplicate content length");
                length = Integer.parseInt(line.substring(line.indexOf(':') + 1).trim());
            }
        }
        if (length < 0 || length > 4 * 1024 * 1024) throw new IOException("Invalid DAP length");
        byte[] body = input.readNBytes(length);
        if (body.length != length) throw new EOFException("Truncated DAP body");
        return Json.object(Json.parse(new String(body, StandardCharsets.UTF_8)));
    }
}

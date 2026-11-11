import java.util.*;

/** Deliberately small JSON codec for the dependency-free feasibility adapter. */
final class Json {
    private final String text;
    private int pos;

    private Json(String text) { this.text = text; }

    static Object parse(String text) {
        var parser = new Json(text);
        Object value = parser.value();
        parser.space();
        if (parser.pos != text.length()) throw new IllegalArgumentException("Trailing JSON");
        return value;
    }

    private void space() {
        while (pos < text.length() && " \r\n\t".indexOf(text.charAt(pos)) >= 0) pos++;
    }

    private char take() {
        if (pos == text.length()) throw new IllegalArgumentException("Truncated JSON");
        return text.charAt(pos++);
    }

    private void expect(char c) {
        space();
        if (take() != c) throw new IllegalArgumentException("Expected " + c);
    }

    private Object value() {
        space();
        if (pos == text.length()) throw new IllegalArgumentException("Missing JSON value");
        char c = text.charAt(pos);
        if (c == '"') return string();
        if (c == '{') {
            pos++;
            var out = new LinkedHashMap<String, Object>();
            space();
            if (pos < text.length() && text.charAt(pos) == '}') { pos++; return out; }
            do {
                space();
                String key = string();
                expect(':');
                if (out.containsKey(key)) throw new IllegalArgumentException("Duplicate key");
                out.put(key, value());
                space();
                c = take();
                if (c == '}') return out;
                if (c != ',') throw new IllegalArgumentException("Expected comma");
            } while (true);
        }
        if (c == '[') {
            pos++;
            var out = new ArrayList<Object>();
            space();
            if (pos < text.length() && text.charAt(pos) == ']') { pos++; return out; }
            do {
                out.add(value());
                space();
                c = take();
                if (c == ']') return out;
                if (c != ',') throw new IllegalArgumentException("Expected comma");
            } while (true);
        }
        for (String literal : List.of("true", "false", "null")) {
            if (text.startsWith(literal, pos)) {
                pos += literal.length();
                return literal.equals("null") ? null : literal.equals("true");
            }
        }
        int start = pos;
        while (pos < text.length() && "-+0123456789.eE".indexOf(text.charAt(pos)) >= 0) pos++;
        String number = text.substring(start, pos);
        if (!number.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?"))
            throw new IllegalArgumentException("Invalid JSON number");
        if (number.contains(".") || number.contains("e") || number.contains("E"))
            return Double.valueOf(number);
        return Long.valueOf(number);
    }

    private String string() {
        if (take() != '"') throw new IllegalArgumentException("Expected string");
        var out = new StringBuilder();
        while (true) {
            char c = take();
            if (c == '"') return out.toString();
            if (c < 32) throw new IllegalArgumentException("Control character in JSON string");
            if (c != '\\') { out.append(c); continue; }
            char escaped = take();
            switch (escaped) {
                case '"', '\\', '/' -> out.append(escaped);
                case 'b' -> out.append('\b');
                case 'f' -> out.append('\f');
                case 'n' -> out.append('\n');
                case 'r' -> out.append('\r');
                case 't' -> out.append('\t');
                case 'u' -> {
                    if (pos + 4 > text.length()) throw new IllegalArgumentException("Truncated escape");
                    out.append((char) Integer.parseInt(text.substring(pos, pos + 4), 16));
                    pos += 4;
                }
                default -> throw new IllegalArgumentException("Invalid JSON escape");
            }
        }
    }

    static String write(Object value) {
        if (value == null) return "null";
        if (value instanceof String s) {
            var out = new StringBuilder("\"");
            for (char c : s.toCharArray()) {
                switch (c) {
                    case '"' -> out.append("\\\"");
                    case '\\' -> out.append("\\\\");
                    case '\n' -> out.append("\\n");
                    case '\r' -> out.append("\\r");
                    case '\t' -> out.append("\\t");
                    default -> {
                        if (c < 32) out.append(String.format("\\u%04x", (int) c));
                        else out.append(c);
                    }
                }
            }
            return out.append('"').toString();
        }
        if (value instanceof Map<?, ?> map) {
            var entries = new ArrayList<String>();
            for (var e : map.entrySet()) entries.add(write(e.getKey().toString()) + ":" + write(e.getValue()));
            return "{" + String.join(",", entries) + "}";
        }
        if (value instanceof Collection<?> list)
            return "[" + String.join(",", list.stream().map(Json::write).toList()) + "]";
        if (value instanceof Number || value instanceof Boolean) return value.toString();
        throw new IllegalArgumentException("Unsupported JSON value " + value.getClass());
    }

    static Map<String, Object> object(Object value) {
        if (!(value instanceof Map<?, ?> map)) throw new IllegalArgumentException("Expected JSON object");
        var out = new LinkedHashMap<String, Object>();
        map.forEach((key, val) -> out.put((String) key, val));
        return out;
    }

    static List<?> array(Object value) {
        if (!(value instanceof List<?> list)) throw new IllegalArgumentException("Expected JSON array");
        return list;
    }

    static int integer(Map<String, Object> map, String key) {
        if (!(map.get(key) instanceof Long n) || n < Integer.MIN_VALUE || n > Integer.MAX_VALUE)
            throw new IllegalArgumentException("Expected integer: " + key);
        return n.intValue();
    }
}

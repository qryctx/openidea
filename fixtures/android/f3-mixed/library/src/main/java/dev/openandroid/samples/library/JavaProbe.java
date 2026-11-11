package dev.openandroid.samples.library;

import java.util.List;
import java.util.Map;

public final class JavaProbe {
    private JavaProbe() {}

    public static String levelTwo(Value value, int[] values, List<String> labels,
            Map<String, Integer> counters) {
        int sum = values[0] + values[1] + values[2];
        String title = value.title + "-" + labels.get(0);
        return KotlinProbe.levelThree(title, sum, counters.get("count")); // BREAKPOINT-TARGET-1
    }

    public static final class Value {
        public final String title;
        public final int count;

        public Value(String title, int count) {
            this.title = title;
            this.count = count;
        }
    }
}

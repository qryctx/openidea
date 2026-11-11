package dev.openandroid.samples.java;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class MainActivity extends Activity {
    private Thread worker;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.main);
        worker = new Thread(this::runProbe, "OAS-java");
        worker.start();
    }

    private void runProbe() {
        try {
            Thread.sleep(2000);
            for (int iteration = 0; iteration < 10; iteration++) {
                Log.i("OAS", "java iteration=" + iteration + " " + levelOne(iteration));
                Thread.sleep(1000);
            }
        } catch (InterruptedException cancelled) {
            Thread.currentThread().interrupt();
            Log.i("OAS", "java probe cancelled");
        }
    }

    private String levelOne(int iteration) {
        int count = iteration + 1;
        String title = "java";
        int[] values = {iteration, count, count * 2};
        List<String> labels = Arrays.asList("first", "second");
        Map<String, Integer> counters = new HashMap<>();
        counters.put("iteration", iteration);
        counters.put("count", count);
        ProbeValue value = new ProbeValue(title, count);
        return levelTwo(value, values, labels, counters); // BREAKPOINT-TARGET-1
    }

    private String levelTwo(ProbeValue value, int[] values, List<String> labels,
            Map<String, Integer> counters) {
        int sum = values[0] + values[1] + values[2];
        String decorated = value.title + "-" + labels.get(0);
        return levelThree(decorated, sum, counters.get("count")); // BREAKPOINT-TARGET-2
    }

    private String levelThree(String title, int sum, int count) {
        boolean even = sum % 2 == 0;
        String result = title + ":sum=" + sum + ":count=" + count + ":even=" + even;
        return result; // BREAKPOINT-TARGET-3
    }

    @Override
    public void onDestroy() {
        worker.interrupt();
        super.onDestroy();
    }

    private static final class ProbeValue {
        final String title;
        final int count;

        ProbeValue(String title, int count) {
            this.title = title;
            this.count = count;
        }
    }
}

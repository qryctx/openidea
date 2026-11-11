package spike;

public class DebugTarget {
    public int field = 9;
    public static int helper(int arg) {
        int local = arg + 1; // BREAKPOINT-INNER
        return local * 2; // BREAKPOINT-RETURN
    }
    public int work(int seed) {
        int local = seed + field;
        int[] values = {seed, field, local};
        int result = helper(local); // BREAKPOINT-JAVA
        System.out.println(result + values[0]); // BREAKPOINT-AFTER
        return result;
    }
    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("progress")) {
            var input = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));
            var target = new DebugTarget();
            int iteration = 0;
            while (true) {
                target.work(iteration++);
                if (System.in.available() > 0) System.out.println("HEARTBEAT:" + input.readLine());
                Thread.sleep(50);
            }
        }
        new DebugTarget().work(3);
        System.out.println("READY");
        while (true) Thread.sleep(100);
    }
}

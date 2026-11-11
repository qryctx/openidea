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
        new DebugTarget().work(3);
        System.out.println("READY");
        while (true) Thread.sleep(100);
    }
}

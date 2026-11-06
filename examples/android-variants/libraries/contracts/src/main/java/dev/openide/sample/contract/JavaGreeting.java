package dev.openide.sample.contract;

public final class JavaGreeting {
    public String message() {
        return "Hello from Java";
    }

    public String message(String suffix) {
        return suffix;
    }
}

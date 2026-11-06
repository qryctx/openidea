package dev.openide.sample.decoy;

final class JavaGreeting {
    String message() {
        return "decoy";
    }

    static String localReference() {
        return new JavaGreeting().message();
    }
}

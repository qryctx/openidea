package dev.openide.sample.contract;

final class JavaCaller {
    static String kotlinMessage() {
        var greeting = new KotlinGreeting();
        return greeting.message() + greeting.message("!");
    }
}

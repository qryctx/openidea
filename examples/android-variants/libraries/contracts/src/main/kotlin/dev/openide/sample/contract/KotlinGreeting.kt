package dev.openide.sample.contract

class KotlinGreeting {
    fun message(): String {
        val greeting = "Hello from Kotlin"
        return greeting
    }
    fun message(suffix: String): String = suffix
}

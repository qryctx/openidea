package dev.openide.sample.contract

class KotlinGreeting {
    fun message(): String = "Hello from Kotlin"
    fun message(suffix: String): String = suffix
}

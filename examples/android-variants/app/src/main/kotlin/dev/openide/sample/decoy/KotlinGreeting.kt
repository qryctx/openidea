package dev.openide.sample.decoy

internal class KotlinGreeting {
    fun message(): String = "decoy"
}

internal fun localReference() = KotlinGreeting().message()

// JavaGreeting, KotlinGreeting and message() are just text on this line.
internal const val exampleText = "JavaGreeting KotlinGreeting message()"

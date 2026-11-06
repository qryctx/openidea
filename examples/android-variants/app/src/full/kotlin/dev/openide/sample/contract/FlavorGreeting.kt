package dev.openide.sample.contract

fun flavorGreeting(): String {
    val greeting = JavaGreeting()
    return "Full: " + greeting.message() + greeting.message("!") + " / " + JavaCaller.kotlinMessage()
}

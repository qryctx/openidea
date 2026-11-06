package dev.openide.sample.contract

fun flavorGreeting(): String {
    val greeting = JavaGreeting()
    return "Demo: " + greeting.message() + greeting.message("!") + " / " + JavaCaller.kotlinMessage()
}

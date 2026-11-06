package dev.openide.sample

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import dev.openide.sample.contract.flavorGreeting

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val button = Button(this)
        button.text = "Show greeting"
        button.setOnClickListener { button.text = flavorGreeting() }
        setContentView(button)
    }
}

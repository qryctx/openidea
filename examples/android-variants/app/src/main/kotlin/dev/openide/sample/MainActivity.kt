package dev.openide.sample

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import dev.openide.sample.contract.flavorGreeting

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val variant = BuildConfig.FLAVOR + BuildConfig.BUILD_TYPE.replaceFirstChar { it.uppercaseChar() }
        val greeting = flavorGreeting()
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
        }
        for ((label, size) in listOf(variant to 28f, packageName to 18f, greeting to 18f)) {
            page.addView(TextView(this).apply {
                text = label
                textSize = size
                gravity = Gravity.CENTER
            })
        }
        setContentView(page)
        Log.i("OpenAndroidStudioRun", "launch variant=$variant package=$packageName greeting=$greeting")
    }
}

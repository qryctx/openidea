package dev.openandroid.samples.mixed

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import dev.openandroid.samples.library.JavaProbe

class MainActivity : Activity() {
    private lateinit var worker: Thread

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(TextView(this).apply { text = getString(R.string.audience) })
        worker = Thread({
            try {
                Thread.sleep(2000)
                repeat(10) { iteration ->
                    val message = levelOne(iteration) // BREAKPOINT-TARGET-1
                    Log.i("OAS", "mixed iteration=$iteration $message")
                    Thread.sleep(1000)
                }
            } catch (cancelled: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.i("OAS", "mixed probe cancelled")
            }
        }, "OAS-mixed")
        worker.start()
    }

    private fun levelOne(iteration: Int): String {
        val count = iteration + 1
        val values = intArrayOf(iteration, count, count * 2)
        val labels = listOf("first", "second")
        val counters = mapOf("iteration" to iteration, "count" to count)
        val value = JavaProbe.Value("mixed", count)
        return JavaProbe.levelTwo(value, values, labels, counters) // BREAKPOINT-TARGET-2
    }

    override fun onDestroy() {
        worker.interrupt()
        super.onDestroy()
    }
}

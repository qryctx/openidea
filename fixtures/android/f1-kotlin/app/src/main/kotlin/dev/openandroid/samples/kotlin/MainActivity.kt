package dev.openandroid.samples.kotlin

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var worker: Thread

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(TextView(this).apply { text = "OAS Kotlin debug sample" })
        worker = Thread({
            try {
                Thread.sleep(2000)
                repeat(10) { iteration ->
                    Log.i("OAS", "kotlin iteration=$iteration ${levelOne(iteration)}")
                    Thread.sleep(1000)
                }
            } catch (cancelled: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.i("OAS", "kotlin probe cancelled")
            }
        }, "OAS-kotlin")
        worker.start()
    }

    private fun levelOne(iteration: Int): String {
        val count = iteration + 1
        val title = "kotlin"
        val values = intArrayOf(iteration, count, count * 2)
        val labels = listOf("first", "second")
        val counters = mapOf("iteration" to iteration, "count" to count)
        val value = ProbeValue(title, count)
        val transform: (Int) -> Int = { number -> number + count }
        return levelTwo(value, values, labels, counters, transform) // BREAKPOINT-TARGET-1
    }

    private fun levelTwo(value: ProbeValue, values: IntArray, labels: List<String>,
            counters: Map<String, Int>, transform: (Int) -> Int): String {
        val sum = values.sum()
        val decorated = "${value.title}-${labels.first()}"
        val transformed = transform(sum) // BREAKPOINT-TARGET-2
        return levelThree(decorated, transformed, counters.getValue("count"))
    }

    private fun levelThree(title: String, sum: Int, count: Int): String {
        val even = sum % 2 == 0
        val result = "$title:sum=$sum:count=$count:even=$even"
        return result // BREAKPOINT-TARGET-3
    }

    override fun onDestroy() {
        worker.interrupt()
        super.onDestroy()
    }

    private data class ProbeValue(val title: String, val count: Int)
}

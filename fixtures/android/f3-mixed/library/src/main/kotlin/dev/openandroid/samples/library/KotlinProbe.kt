package dev.openandroid.samples.library

object KotlinProbe {
    @JvmStatic
    fun levelThree(title: String, sum: Int, count: Int): String {
        val even = sum % 2 == 0
        val transform: (Int) -> Int = { number -> number + count }
        val transformed = transform(sum) // BREAKPOINT-TARGET-1
        val result = "$title:sum=$transformed:count=$count:even=$even"
        return result // BREAKPOINT-TARGET-2
    }
}

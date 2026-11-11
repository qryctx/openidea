package org.openandroidstudio.fixtures.compose

import android.app.Activity
import android.os.Bundle
import androidx.compose.foundation.text.BasicText
import androidx.compose.ui.platform.ComposeView

class MainActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(ComposeView(this).apply {
            setContent { BasicText("Compose build probe") }
        })
    }
}

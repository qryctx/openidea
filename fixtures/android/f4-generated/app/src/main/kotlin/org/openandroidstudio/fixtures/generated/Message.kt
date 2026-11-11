package org.openandroidstudio.fixtures.generated

import org.openandroidstudio.fixtures.processor.GenerateGreeting

@GenerateGreeting
class Message {
    fun text(): String = JavaLabel.decorate(GeneratedGreeting.text())
}

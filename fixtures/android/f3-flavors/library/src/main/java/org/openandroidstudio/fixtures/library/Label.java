package org.openandroidstudio.fixtures.library;

public final class Label {
    private Label() {}

    public static String format(String audience, boolean trace) {
        return audience + (trace ? " (trace)" : "");
    }
}

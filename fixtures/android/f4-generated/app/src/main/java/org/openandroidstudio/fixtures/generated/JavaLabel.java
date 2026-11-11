package org.openandroidstudio.fixtures.generated;

public final class JavaLabel {
    private JavaLabel() {}

    public static String decorate(String message) {
        return BuildConfig.DEBUG ? "[" + message + "]" : message;
    }
}

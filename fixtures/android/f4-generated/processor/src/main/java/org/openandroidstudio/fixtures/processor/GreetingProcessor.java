package org.openandroidstudio.fixtures.processor;

import java.io.IOException;
import java.io.Writer;
import java.util.Set;
import javax.annotation.processing.AbstractProcessor;
import javax.annotation.processing.RoundEnvironment;
import javax.annotation.processing.SupportedAnnotationTypes;
import javax.annotation.processing.SupportedSourceVersion;
import javax.lang.model.SourceVersion;
import javax.lang.model.element.TypeElement;
import javax.tools.Diagnostic;

@SupportedAnnotationTypes("org.openandroidstudio.fixtures.processor.GenerateGreeting")
@SupportedSourceVersion(SourceVersion.RELEASE_17)
public final class GreetingProcessor extends AbstractProcessor {
    @Override
    public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment round) {
        for (var element : round.getElementsAnnotatedWith(GenerateGreeting.class)) {
            String pkg = processingEnv.getElementUtils().getPackageOf(element).getQualifiedName().toString();
            try (Writer writer = processingEnv.getFiler()
                    .createSourceFile(pkg + ".GeneratedGreeting", element).openWriter()) {
                writer.write("package " + pkg + ";\n"
                        + "public final class GeneratedGreeting {\n"
                        + " public static String text() { return \"kapt generated greeting\"; }\n"
                        + "}\n");
            } catch (IOException failure) {
                processingEnv.getMessager().printMessage(Diagnostic.Kind.ERROR, failure.toString(), element);
            }
        }
        return true;
    }
}

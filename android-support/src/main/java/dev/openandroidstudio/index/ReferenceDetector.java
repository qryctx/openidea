package dev.openandroidstudio.index;

import com.android.tools.lint.client.api.UElementHandler;
import com.android.tools.lint.detector.api.*;
import com.intellij.psi.*;
import com.intellij.psi.util.TypeConversionUtil;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.stream.Collectors;
import org.jetbrains.kotlin.lexer.KtTokens;
import org.jetbrains.kotlin.psi.*;
import org.jetbrains.uast.*;

/** Runs in lint with the Android Gradle Plugin's variant-specific classpath and UAST resolvers. */
public final class ReferenceDetector extends Detector implements SourceCodeScanner {
    static final Issue ISSUE = Issue.create("OpenAndroidClassIndex", "Android resolved reference",
        "Carries resolved source locations to the editor.", Category.CORRECTNESS, 1,
        Severity.INFORMATIONAL, new Implementation(ReferenceDetector.class, Scope.JAVA_FILE_SCOPE));

    @Override public List<Class<? extends UElement>> getApplicableUastTypes() {
        return List.of(UFile.class, UClass.class, UMethod.class, UCallExpression.class);
    }

    @Override public UElementHandler createUastHandler(JavaContext context) {
        return new Collector(context);
    }

    private static class Collector extends UElementHandler {
        private final JavaContext context;
        Collector(JavaContext context) { this.context = context; }

        @Override public void visitFile(UFile file) {
            try {
                String text = Files.readString(context.file.toPath()).replace("\r\n", "\n").replace('\r', '\n');
                if (text.startsWith("\uFEFF")) text = text.substring(1);
                String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(text.getBytes(StandardCharsets.UTF_8)));
                emit("source", digest, context.getLocation(file));
            } catch (Exception e) {
                throw new IllegalStateException("Could not fingerprint " + context.file, e);
            }
        }

        @Override public void visitClass(UClass klass) {
            if (klass.getQualifiedName() != null && klass.getName() != null) {
                emit("decl", klass.getQualifiedName(), context.getNameLocation(klass));
            }
        }

        @Override public void visitMethod(UMethod method) {
            if (method.isConstructor()) return;
            PsiElement source = method.getSourcePsi();
            PsiElement identifier;
            if (source instanceof PsiMethod java) {
                identifier = java.getNameIdentifier();
            } else if (source instanceof KtNamedFunction kotlin && kotlin.getParent() instanceof KtClassBody
                    && kotlin.getReceiverTypeReference() == null && !kotlin.hasModifier(KtTokens.SUSPEND_KEYWORD)) {
                identifier = kotlin.getNameIdentifier();
            } else {
                return;
            }
            String key = methodKey(method.getJavaPsi());
            if (key != null && identifier != null) emit("decl", key, context.getLocation(identifier));
        }

        @Override public void visitCallExpression(UCallExpression call) {
            if (call.getSourcePsi() == null) return;
            if (UastCallKind.CONSTRUCTOR_CALL.equals(call.getKind())) {
                visitConstructorCall(call);
            } else if (UastCallKind.METHOD_CALL.equals(call.getKind())) {
                visitNamedMethodCall(call);
            }
        }

        private void visitConstructorCall(UCallExpression call) {
            Location location = context.getNameLocation(call);
            PsiMethod constructor = call.resolve();
            if (constructor == null || !constructor.isConstructor()) {
                emit("unresolved", "constructor", location);
                return;
            }
            PsiClass owner = constructor.getContainingClass();
            if (owner == null || owner.getQualifiedName() == null) return;
            if (call.getSourcePsi() instanceof PsiNewExpression expression
                    && expression.getClassReference() != null
                    && expression.getClassReference().getReferenceNameElement() != null) {
                location = context.getLocation(expression.getClassReference().getReferenceNameElement());
            }
            emit("use", owner.getQualifiedName(), location);
        }

        private void visitNamedMethodCall(UCallExpression call) {
            PsiElement token;
            String sourceName;
            if (call.getSourcePsi() instanceof PsiMethodCallExpression java) {
                token = java.getMethodExpression().getReferenceNameElement();
                sourceName = java.getMethodExpression().getReferenceName();
            } else if (call.getSourcePsi() instanceof KtCallExpression kotlin
                    && kotlin.getCalleeExpression() instanceof KtNameReferenceExpression name) {
                token = name.getReferencedNameElement();
                sourceName = name.getReferencedName();
            } else {
                return; // Operators, property access and implicit calls have no explicit method token.
            }
            if (token == null || sourceName == null) return;
            Location location = context.getLocation(token);
            PsiMethod resolved = call.resolve();
            if (resolved == null) {
                emit("incomplete-method", sourceName, location);
                return;
            }
            String jvmName = resolved.getName();
            if (!jvmName.equals(sourceName)) {
                // A Kotlin alias, operator or @JvmName can spell a different source token.
                // Withhold both name families until source and JVM declarations can be joined.
                emit("incomplete-method", sourceName, location);
                emit("incomplete-method", jvmName, location);
                return;
            }
            String key = methodKey(resolved);
            if (key != null) emit("use", key, location);
        }

        private void emit(String kind, String symbol, Location loc) {
            Position start = loc.getStart(), end = loc.getEnd();
            if (start == null || end == null) return;
            String record = String.join("|", kind, symbol, Integer.toString(start.getLine()),
                Integer.toString(start.getColumn()), Integer.toString(end.getLine()),
                Integer.toString(end.getColumn()));
            context.report(ISSUE, loc, record);
        }
    }

    private static String methodKey(PsiMethod method) {
        if (method == null || method.isConstructor()) return null;
        PsiClass owner = method.getContainingClass();
        if (owner == null || owner.getQualifiedName() == null) return null;
        String parameters = Arrays.stream(method.getParameterList().getParameters())
            .map(p -> TypeConversionUtil.erasure(p.getType()))
            .map(t -> t instanceof PsiEllipsisType varargs ? varargs.toArrayType() : t)
            .map(t -> t.getCanonicalText(false)).collect(Collectors.joining(","));
        return owner.getQualifiedName() + "#" + method.getName() + "(" + parameters + ")";
    }
}

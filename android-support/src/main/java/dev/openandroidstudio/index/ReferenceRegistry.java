package dev.openandroidstudio.index;

import com.android.tools.lint.client.api.IssueRegistry;
import com.android.tools.lint.client.api.Vendor;
import com.android.tools.lint.detector.api.ApiKt;
import com.android.tools.lint.detector.api.Issue;
import java.util.List;

public final class ReferenceRegistry extends IssueRegistry {
    @Override public Vendor getVendor() { return new Vendor("OpenIDEA Android", "dev.openandroidstudio.index"); }
    @Override public int getApi() { return ApiKt.CURRENT_API; }
    @Override public List<Issue> getIssues() { return List.of(ReferenceDetector.ISSUE); }
}

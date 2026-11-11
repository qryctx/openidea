package org.openandroidstudio.fixtures.flavors;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import org.openandroidstudio.fixtures.library.Label;

public final class MainActivity extends Activity {
    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView label = new TextView(this);
        label.setText(Label.format(getString(R.string.audience), BuildConfig.TRACE_ENABLED));
        setContentView(label);
    }
}

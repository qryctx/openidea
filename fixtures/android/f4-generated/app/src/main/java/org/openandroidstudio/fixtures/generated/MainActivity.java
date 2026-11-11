package org.openandroidstudio.fixtures.generated;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public final class MainActivity extends Activity {
    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView label = new TextView(this);
        label.setText(getString(R.string.app_name) + ": " + new Message().text());
        setContentView(label);
    }
}

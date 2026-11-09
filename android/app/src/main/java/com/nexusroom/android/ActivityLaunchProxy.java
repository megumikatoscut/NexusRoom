package com.nexusroom.android;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** Short-lived visible handoff for external Activity launches on OEM Android. */
public final class ActivityLaunchProxy extends Activity {
    static final String EXTRA_TARGET = "nexusroom.target_activity";

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent target = android.os.Build.VERSION.SDK_INT >= 33
            ? getIntent().getParcelableExtra(EXTRA_TARGET, Intent.class)
            : getIntent().getParcelableExtra(EXTRA_TARGET);
        if (target != null) {
            target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { startActivity(target); } catch (Exception ignored) { }
        }
        finish();
    }
}

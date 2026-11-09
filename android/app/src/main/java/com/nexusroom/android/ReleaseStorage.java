package com.nexusroom.android;

import android.content.Context;
import android.content.SharedPreferences;

final class ReleaseStorage {
    private static final String NAMESPACE = "v" + BuildConfig.VERSION_NAME;

    static SharedPreferences preferences(Context context, String name) {
        return context.getSharedPreferences("nexusroom-" + NAMESPACE + "-" + name, Context.MODE_PRIVATE);
    }
}

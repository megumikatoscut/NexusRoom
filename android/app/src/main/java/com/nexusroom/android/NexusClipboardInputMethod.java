package com.nexusroom.android;

import android.inputmethodservice.InputMethodService;
import android.content.ComponentName;
import android.content.Context;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Android only allows the selected IME to read clipboard contents while its app is
 * in the background. This deliberately small bridge is an explicit, user-selected
 * opt-in; it does not pretend to be a text keyboard or switch IMEs behind the user's
 * back.
 */
public final class NexusClipboardInputMethod extends InputMethodService {
    static boolean isSelected(Context context) {
        String current = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.DEFAULT_INPUT_METHOD);
        return new ComponentName(context, NexusClipboardInputMethod.class).flattenToString().equals(current);
    }

    @Override
    public View onCreateInputView() {
        int padding = Math.round(16 * getResources().getDisplayMetrics().density);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(padding, padding / 2, padding, padding / 2);
        panel.setBackgroundColor(0xfff5f8f7);

        TextView explanation = new TextView(this);
        explanation.setText(R.string.clipboard_bridge_explanation);
        explanation.setTextColor(0xff16302d);
        explanation.setTextSize(14);
        explanation.setPadding(0, 0, 0, padding / 2);
        panel.addView(explanation, new LinearLayout.LayoutParams(-1, -2));

        Button switchKeyboard = new Button(this);
        switchKeyboard.setText("切换到下一个键盘");
        switchKeyboard.setAllCaps(false);
        switchKeyboard.setOnClickListener(view -> switchToNextInputMethod(false));
        panel.addView(switchKeyboard, new LinearLayout.LayoutParams(-1, -2));

        Button hide = new Button(this);
        hide.setText("隐藏");
        hide.setAllCaps(false);
        hide.setOnClickListener(view -> requestHideSelf(0));
        panel.addView(hide, new LinearLayout.LayoutParams(-1, -2));
        return panel;
    }
}

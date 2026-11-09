import com.android.builder.testing.MockableJarGenerator;
import java.io.File;

// The Android Gradle plugin's own unit-test platform, without building an APK.
public final class GenerateMockableAndroid {
 public static void main(String[] args)throws Exception {
  new MockableJarGenerator(true).createMockableJar(new File(args[0]),new File(args[1]));
 }
}

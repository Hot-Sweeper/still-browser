// Query Plasma's real task model, without opening a window.
import QtQml
import org.kde.taskmanager as TM
QtObject {
    property int targetPid: Number(Qt.application.arguments[Qt.application.arguments.length - 1])
    property var tasks: TM.TasksModel { groupMode: TM.TasksModel.GroupDisabled }
    property var timer: Timer {
        interval: 1000
        running: true
        onTriggered: {
            for (var i = 0; i < tasks.count; ++i) {
                var index = tasks.index(i, 0);
                if (Number(tasks.data(index, TM.AbstractTasksModel.AppPid)) !== targetPid) continue;
                var id = tasks.data(index, TM.AbstractTasksModel.AppId);
                var name = tasks.data(index, TM.AbstractTasksModel.AppName);
                var launcher = String(tasks.data(index, TM.AbstractTasksModel.LauncherUrlWithoutIcon));
                if (id === "still" && name === "Still" && launcher === "applications:still.desktop") {
                    console.log("PASS: Plasma task is Still and uses still.desktop");
                    Qt.quit();
                    return;
                }
                console.error("Wrong Plasma task mapping:", id, name, launcher);
                Qt.exit(1);
                return;
            }
            console.error("Still window missing from Plasma task model");
            Qt.exit(1);
        }
    }
}

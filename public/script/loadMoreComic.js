


var loadmoreElement = document.getElementById("loadMore");
var BodyComic = document.getElementById("bodyComic");
var offset = 12;
var inQuery = 0;
function LoadMorefun(){
    if(inQuery == 1) return;
    inQuery = 1;
    if(!document.getElementById("loading_text")){
        document.getElementById("content_body").insertAdjacentHTML("beforeend",`
        <center id="loading_text">Loading...</center>
        `)
    }
    // http://localhost:8082/ajax/comic/1
    fetch("/ajax/comic/"+offset,{
        method:"put"
    }).then(response => response.json())
    .then(data_array => {
        data_array.forEach((data)=>{
        BodyComic.insertAdjacentHTML("beforeend", `
            <a style="text-decoration: none;" class="col-md-3" href="comic/show/`+data.id+`">

                <div class="d-flex align-items-center" style="height: 300px;  border-radius: 2.5%;"> 
                <img style="max-height: 100%;max-width: 100%;" src="public/uploads/`+data.savedFolder+`/`+data.coverImage+`" class="mx-auto d-block coverImage" alt="`+data.title+`">
                
                </div>
                <p class="text-justify text-white" style="overflow:hidden;">`+data.title+`</p>
            </a>
          `);
        })
        if(data_array.length != 0){
            inQuery = 0
        }
        if(document.getElementById("loading_text")){
            document.getElementById("loading_text").remove();
        }
    });
    offset = offset + 12 // ose offset += 12
}


var isInViewport = function (elem,toleranc = 0) {
    if(elem){
    var bounding = elem.getBoundingClientRect();
    isinView = (bounding.top >= 0 && bounding.bottom-toleranc <= (window.innerHeight || document.documentElement.clientHeight));
    return isinView;
    }
};

document.addEventListener("scroll",()=>{
    if(isInViewport(loadmoreElement,400)){
        LoadMorefun();
    }
})
